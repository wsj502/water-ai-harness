/**
 * Agent Loop 离线闭环（迁移自 scripts/loop-mock-test.ts）：
 * MockProvider 两轮真实走查——工具请求 → 审批放行 → 结果回填 → 结论。
 */
import { describe, expect, it } from 'vitest';
import {
  agentLoop, builtinTools, PermissionEngine,
  type ChatRequest, type LoopEvent, type Provider, type StreamEvent, type WMessage,
} from '../packages/core/src/index.js';

class MockProvider implements Provider {
  readonly protocol = 'openai' as const;
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const hasToolResult = req.messages.some(m => m.role === 'tool');
    if (!hasToolResult) {
      yield { type: 'thinking_delta', text: '先看看原型目录…' };
      yield { type: 'text_delta', text: '我来列一下。' };
      yield {
        type: 'tool_use',
        call: { type: 'tool_use', id: 'mock-1', name: 'glob', input: { pattern: 'prototype/*.html' } },
      };
      yield { type: 'usage', inputTokens: 120, outputTokens: 30 };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: '结论：原型共 5 页。' };
      yield { type: 'usage', inputTokens: 260, outputTokens: 45 };
      yield { type: 'done', stopReason: 'end' };
    }
  }
}

describe('Agent Loop 离线闭环', () => {
  it('完整两轮：工具调用 → 结果回填 → 结论，历史结构合法', async () => {
    const messages: WMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: '看看原型目录里有哪些页面？' }] },
    ];
    const events: LoopEvent[] = [];
    for await (const ev of agentLoop({
      provider: new MockProvider(), model: 'mock', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxTurns: 10,
    })) events.push(ev);

    // 事件序列：turn_start → thinking/text → tool 执行（glob 真的跑了）→ 第二轮 → finish(end)
    expect(events.some(e => e.type === 'tool_result' && !e.isError)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'end' });

    // 历史结构：system 头部 + 消息角色序列
    expect(messages[0]!.role).toBe('system');
    expect(messages.map(m => m.role)).toEqual([
      'system', 'user', 'assistant', 'tool', 'assistant',
    ]);
    // assistant 轮含 thinking + text + tool_use 三种 part
    expect(messages[2]!.parts.map(p => p.type)).toEqual(['thinking', 'text', 'tool_use']);
    // tool 轮回填 tool_result 且非错误
    const tr = messages[3]!.parts[0]!;
    expect(tr.type).toBe('tool_result');
    expect(tr.type === 'tool_result' && tr.isError).toBeFalsy();
    expect(tr.type === 'tool_result' && tr.content).toContain('prototype/');
  });

  it('无审批渠道时 ask 降级为 deny（保守拒绝）', async () => {
    const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '跑命令' }] }];
    // shell 是 high 风险 → ask → 无 approve 回调 → deny
    const events: LoopEvent[] = [];
    for await (const ev of agentLoop({
      provider: new MockShellProvider(), model: 'mock', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxTurns: 5,
    })) events.push(ev);
    expect(events.some(e => e.type === 'tool_denied')).toBe(true);
    // 拒绝也是结果：历史里 tool 轮是 isError 的 tool_result
    const toolMsg = messages.findLast(m => m.role === 'tool');
    expect(toolMsg?.parts[0]).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('#108 审批等待期间 tool_pending 已实时发射（串行路径不再堵在审批后面）', async () => {
    const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '跑命令' }] }];
    // 手动闸门：approve 挂起，直到测试侧放行——模拟用户还没点批准卡
    let releaseApprove!: (d: 'once' | 'session' | 'deny') => void;
    const gate = new Promise<'once'>(r => { releaseApprove = r; });
    const seenBeforeRelease: LoopEvent[] = [];

    const iter = agentLoop({
      provider: new MockShellProvider(), model: 'mock', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxTurns: 5,
      approve: () => gate,
    });
    // 审批未 resolve 期间消费事件：tool_pending 必须已经到达（前端建块/审批卡渲染的依据）。
    // 超时保护：bug 在场时迭代器会卡在审批 await 上——用竞争让它 3s 内失败而非挂死
    const nextWithTimeout = () => Promise.race([
      iter.next(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tool_pending 未在审批等待期间到达（#108 复现）')), 3000)),
    ]);
    for (let i = 0; i < 10; i++) {
      const r = await nextWithTimeout();
      if (r.done) break;
      seenBeforeRelease.push(r.value);
      if (r.value.type === 'tool_pending') break;
    }
    expect(seenBeforeRelease.some(e => e.type === 'tool_pending')).toBe(true);
    releaseApprove('once'); // 用户点了批准
    for (;;) {
      const r = await iter.next();
      if (r.done) break;
      seenBeforeRelease.push(r.value);
    }
    // 批准后完整收尾：approved → result → 下一轮 → finish(end)
    expect(seenBeforeRelease.some(e => e.type === 'tool_approved')).toBe(true);
    expect(seenBeforeRelease.some(e => e.type === 'tool_result' && !e.isError)).toBe(true);
    expect(seenBeforeRelease.at(-1)).toMatchObject({ type: 'finish', reason: 'end' });
  });
});

/** 一上来就请求 shell 的 mock */
class MockShellProvider implements Provider {
  readonly protocol = 'openai' as const;
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!req.messages.some(m => m.role === 'tool')) {
      yield {
        type: 'tool_use',
        call: { type: 'tool_use', id: 'sh-1', name: 'shell', input: { command: 'echo hi' } },
      };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: '好的' };
      yield { type: 'done', stopReason: 'end' };
    }
  }
}
