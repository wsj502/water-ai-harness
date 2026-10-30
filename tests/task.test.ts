/**
 * M8 子代理测试：task 工具派生只读研究子代理（嵌套 Agent Loop）。
 *
 * 技巧：一个 Provider 类按「工具集里有没有 task」区分自己身处父循环还是子循环
 * （子循环的工具集被过滤为只读且无 task）——天然可断言防递归。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentLoop, builtinTools, PermissionEngine,
  type ChatRequest, type Provider, type StreamEvent, type WMessage,
} from '../packages/core/src/index.js';

const seenSubToolNames: string[] = [];

class DualRoleProvider implements Provider {
  readonly protocol = 'openai' as const;
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const isSub = !req.tools?.some(t => t.name === 'task');
    const hasToolResult = req.messages.some(m => m.role === 'tool');

    if (isSub) {
      seenSubToolNames.push(...(req.tools ?? []).map(t => t.name));
      if (!hasToolResult) {
        yield {
          type: 'tool_use',
          call: { type: 'tool_use', id: 'sub-1', name: 'glob', input: { pattern: 'tests/*.test.ts' } },
        };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        const toolMsg = req.messages.findLast(m => m.role === 'tool');
        const content = toolMsg?.parts[0]?.type === 'tool_result' ? toolMsg.parts[0].content : '';
        const n = content.split('\n').filter(l => l.trim()).length;
        yield { type: 'text_delta', text: `共 ${n} 个测试文件` };
        yield { type: 'done', stopReason: 'end' };
      }
      return;
    }

    // 父循环
    if (!hasToolResult) {
      yield {
        type: 'tool_use',
        call: {
          type: 'tool_use', id: 'p-1', name: 'task',
          input: { prompt: '统计 tests 目录下 *.test.ts 文件数量', description: '统计测试文件' },
        },
      };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      const toolMsg = req.messages.findLast(m => m.role === 'tool');
      const content = toolMsg?.parts[0]?.type === 'tool_result' ? toolMsg.parts[0].content : '';
      yield { type: 'text_delta', text: `子代理结论：${content}` };
      yield { type: 'done', stopReason: 'end' };
    }
  }
}

describe('M8 子代理（task 工具）', () => {
  it('父循环派生 → 子代理真跑 glob → 结论回填 → 父收尾', async () => {
    const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '帮我统计测试文件' }] }];
    const events = [];
    for await (const ev of agentLoop({
      provider: new DualRoleProvider(), model: 'mock', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxTurns: 10,
      approve: async () => 'once', // task 是 medium 风险：测试提供审批放行
    })) events.push(ev);

    // 子代理真实执行了 glob（read-only 工具，自动放行）
    const tr = events.find(e => e.type === 'tool_result' && e.call.name === 'task');
    expect(tr).toBeDefined();
    expect(tr!.type === 'tool_result' && tr!.result).toMatch(/共 \d+ 个测试文件/);
    // 数量真实（tests 目录现有 6 个测试文件）
    const m = tr!.type === 'tool_result' && tr!.result.match(/共 (\d+) 个/);
    expect(m && Number(m[1])).toBeGreaterThanOrEqual(5);
    // 父循环基于结果收尾
    const final = messages.findLast(x => x.role === 'assistant');
    expect(final?.parts.some(p => p.type === 'text' && p.text.includes('子代理结论'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'end' });
  });

  it('防递归：子循环工具集不含 task（且不含中高风险工具）', () => {
    expect(seenSubToolNames.length).toBeGreaterThan(0);
    expect(seenSubToolNames).not.toContain('task');
    expect(seenSubToolNames).not.toContain('write');
    expect(seenSubToolNames).not.toContain('shell');
    expect(seenSubToolNames).toContain('glob');
  });

  it('task 工具在无 spawnTask 的上下文中明确报错（而非静默）', async () => {
    const task = builtinTools.find(t => t.spec.name === 'task')!;
    const ctx: { cwd: string } = { cwd: process.cwd() };
    // @ts-expect-error 故意构造缺 spawnTask 的上下文
    await expect(task.run({ prompt: 'x' }, ctx)).rejects.toThrow('不能再派生子代理');
  });

  it('中断传播：父级信号中止时子代理循环立即终止并返回兜底文本', async () => {    const ac = new AbortController();
    // 双角色：子循环首轮即中止信号（模拟用户此刻按 Esc）；父循环请求 task
    class AbortProvider implements Provider {
      readonly protocol = 'openai' as const;
      async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
        const isSub = !req.tools?.some(t => t.name === 'task');
        const hasToolResult = req.messages.some(m => m.role === 'tool');
        if (isSub) {
          ac.abort();
          yield { type: 'tool_use', call: { type: 'tool_use', id: 's1', name: 'glob', input: { pattern: '*.x' } } };
          yield { type: 'done', stopReason: 'tool_use' };
          return;
        }
        if (!hasToolResult) {
          yield { type: 'tool_use', call: { type: 'tool_use', id: 'p1', name: 'task', input: { prompt: '随便查' } } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'done', stopReason: 'end' };
        }
      }
    }
    const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '查' }] }];
    const events = [];
    for await (const ev of agentLoop({
      provider: new AbortProvider(), model: 'mock', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxTurns: 5, signal: ac.signal,
      approve: async () => 'once',
    })) events.push(ev);

    // 父级拿到 task 的结果（兜底文本或中断错误结果），整个循环以 aborted 收尾
    expect(events.some(e => e.type === 'tool_result' && e.call.name === 'task')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'aborted' });
  });
});

describe('M12 子代理流式透传 + 可写模式', () => {
  it('子代理事件实时透传：sub_event 先于 task 结果，顺序与 callId 正确', async () => {
    class StreamProvider implements Provider {
      readonly protocol = 'openai' as const;
      async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
        const isSub = !req.tools?.some(t => t.name === 'task');
        const hasToolResult = req.messages.some(m => m.role === 'tool');
        if (isSub) {
          if (!hasToolResult) {
            yield { type: 'text_delta', text: '正在检索…' };
            yield { type: 'tool_use', call: { type: 'tool_use', id: 'sub-x', name: 'glob', input: { pattern: 'tests/*.test.ts' } } };
            yield { type: 'done', stopReason: 'tool_use' };
          } else {
            yield { type: 'text_delta', text: '检索完成' };
            yield { type: 'done', stopReason: 'end' };
          }
          return;
        }
        if (!hasToolResult) {
          yield { type: 'tool_use', call: { type: 'tool_use', id: 'p-stream', name: 'task', input: { prompt: '检索' } } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: '完成' };
          yield { type: 'done', stopReason: 'end' };
        }
      }
    }
    const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '去检索' }] }];
    const events = [];
    for await (const ev of agentLoop({
      provider: new StreamProvider(), model: 'mock', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxTurns: 10,
      approve: async () => 'once',
    })) events.push(ev);

    const subEvents = events.filter(e => e.type === 'sub_event');
    expect(subEvents.length).toBeGreaterThan(0);
    const firstSub = subEvents[0] as { callId: string; ev: { type: string } };
    expect(firstSub.callId).toBe('p-stream');
    expect(firstSub.ev.type).toBe('turn_start');
    // 顺序：子事件（含内部工具）先于父级的 task tool_result
    const firstSubIdx = events.findIndex(e => e.type === 'sub_event');
    const taskResultIdx = events.findIndex(e => e.type === 'tool_result' && (e as { call?: { name?: string } }).call?.name === 'task');
    expect(firstSubIdx).toBeGreaterThan(-1);
    expect(firstSubIdx).toBeLessThan(taskResultIdx);
    // 内部事件完整：文本 + 真实 glob 执行 + 收尾
    const innerTexts = subEvents.map(e => (e as { ev: { type: string; text?: string } }).ev)
      .filter(v => v.type === 'text_delta').map(v => v.text);
    expect(innerTexts).toEqual(['正在检索…', '检索完成']);
    expect(subEvents.some(e => (e as { ev: { type: string } }).ev.type === 'tool_result')).toBe(true);
    expect((subEvents.at(-1) as { ev: { type: string } }).ev.type).toBe('finish');
  });

  it('write 模式：子代理真实落盘，工具集含 write/edit 且无 shell/task', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'water-subw-'));
    try {
      class WriteSubProvider implements Provider {
        readonly protocol = 'openai' as const;
        subToolSets: string[][] = [];
        async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
          const sys = req.messages.find(m => m.role === 'system');
          const sysText = sys?.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('') ?? '';
          const hasToolResult = req.messages.some(m => m.role === 'tool');
          if (sysText.includes('可写执行')) {
            this.subToolSets.push((req.tools ?? []).map(t => t.name));
            if (!hasToolResult) {
              yield { type: 'tool_use', call: { type: 'tool_use', id: 'w1', name: 'write', input: { path: 'note.txt', content: 'written-by-subagent' } } };
              yield { type: 'done', stopReason: 'tool_use' };
            } else {
              yield { type: 'text_delta', text: '已写入 note.txt' };
              yield { type: 'done', stopReason: 'end' };
            }
            return;
          }
          if (!hasToolResult) {
            yield { type: 'tool_use', call: { type: 'tool_use', id: 'pw', name: 'task', input: { prompt: '写 note.txt', mode: 'write', description: '写文件' } } };
            yield { type: 'done', stopReason: 'tool_use' };
          } else {
            yield { type: 'text_delta', text: '好的' };
            yield { type: 'done', stopReason: 'end' };
          }
        }
      }
      const p = new WriteSubProvider();
      const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '让它写' }] }];
      const events = [];
      for await (const ev of agentLoop({
        provider: p, model: 'mock', system: 'SYS', messages,
        tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
        toolCtx: { cwd: tmp }, maxTurns: 10,
        approve: async () => 'once', // write 模式 riskFor → high：逐次审批
      })) events.push(ev);

      expect(existsSync(path.join(tmp, 'note.txt'))).toBe(true);
      expect(readFileSync(path.join(tmp, 'note.txt'), 'utf8')).toBe('written-by-subagent');
      const subTools = p.subToolSets[0] ?? [];
      expect(subTools).toContain('write');
      expect(subTools).toContain('edit');
      expect(subTools).not.toContain('shell');
      expect(subTools).not.toContain('task');
      const tr = events.find(e => e.type === 'tool_result' && (e as { call?: { name?: string } }).call?.name === 'task');
      expect(tr!.type === 'tool_result' && tr!.isError).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('动态风险：write 模式无审批渠道 → 保守拒绝，文件未创建', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'water-subd-'));
    try {
      class DenyProvider implements Provider {
        readonly protocol = 'openai' as const;
        async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
          const hasToolResult = req.messages.some(m => m.role === 'tool');
          const isSub = !req.tools?.some(t => t.name === 'task');
          if (isSub) {
            yield { type: 'text_delta', text: '不该到这里' };
            yield { type: 'done', stopReason: 'end' };
            return;
          }
          if (!hasToolResult) {
            yield { type: 'tool_use', call: { type: 'tool_use', id: 'pd', name: 'task', input: { prompt: '写', mode: 'write' } } };
            yield { type: 'done', stopReason: 'tool_use' };
          } else {
            yield { type: 'text_delta', text: '完成' };
            yield { type: 'done', stopReason: 'end' };
          }
        }
      }
      const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '写' }] }];
      const events = [];
      for await (const ev of agentLoop({
        provider: new DenyProvider(), model: 'mock', system: 'SYS', messages,
        tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
        toolCtx: { cwd: tmp }, maxTurns: 5,
        // 无 approve：riskFor('write')=high → ask → 保守拒绝
      })) events.push(ev);

      expect(events.some(e => e.type === 'tool_denied' && (e as { call?: { name?: string } }).call?.name === 'task')).toBe(true);
      expect(existsSync(path.join(tmp, 'note.txt'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
