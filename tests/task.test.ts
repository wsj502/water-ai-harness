/**
 * M8 子代理测试：task 工具派生只读研究子代理（嵌套 Agent Loop）。
 *
 * 技巧：一个 Provider 类按「工具集里有没有 task」区分自己身处父循环还是子循环
 * （子循环的工具集被过滤为只读且无 task）——天然可断言防递归。
 */
import { describe, expect, it } from 'vitest';
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

  it('中断传播：父级信号中止时子代理循环立即终止并返回兜底文本', async () => {
    const ac = new AbortController();
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
