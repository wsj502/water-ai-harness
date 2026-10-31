/**
 * M27 同轮工具并发执行测试（#76）：
 * 时序（总耗时 < 串行和）/ 失败不中断（allSettled）/ 并发审批 / env 回退串行 / 并发子代理。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentLoop, builtinTools, PermissionEngine, MockProvider,
  type ChatRequest, type Provider, type StreamEvent, type Tool, type WMessage, type AgentLoopOptions,
} from '../packages/core/src/index.js';

afterEach(() => { delete process.env.WATER_PARALLEL_TOOLS; });

/** 一轮 yield N 个 tool_use 的 Provider（第 2 轮收尾） */
function multiToolProvider(specs: Array<{ id: string; name: string; input: Record<string, unknown> }>): Provider {
  return new (class implements Provider {
    readonly protocol = 'openai' as const;
    async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
      const hasToolResult = req.messages.some(m => m.role === 'tool');
      if (!hasToolResult) {
        for (const s of specs) {
          yield { type: 'tool_use', call: { type: 'tool_use', id: s.id, name: s.name, input: s.input } };
        }
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', stopReason: 'end' };
      }
    }
  })();
}

/** 可控延时的测试工具 */
function delayTool(name: string, ms: number, fail = false): Tool {
  return {
    risk: 'low',
    spec: { name, description: `延时 ${ms}ms`, inputSchema: { type: 'object', properties: {} } },
    argSummary: () => name,
    async run() {
      await new Promise(r => setTimeout(r, ms));
      if (fail) throw new Error(`${name} 失败`);
      return `${name} 完成`;
    },
  };
}

const runLoop = async (provider: Provider, tools: Tool[], approve?: AgentLoopOptions['approve'], permissions = new PermissionEngine({ autoAllowLowRisk: true })) => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'water-m27-'));
  const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '并发跑' }] }];
  const events = [];
  const t0 = Date.now();
  try {
    for await (const ev of agentLoop({
      provider, model: 'mock', system: 'SYS', messages,
      tools, permissions, toolCtx: { cwd: tmp }, maxTurns: 6,
      ...(approve ? { approve } : {}),
    })) events.push(ev);
    return { events, elapsed: Date.now() - t0, tmp };
  } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
};

describe('M27 同轮工具并发执行', () => {
  it('并发时序：两个 150ms 工具总耗时 < 280ms（串行 ≥300ms）', async () => {
    const provider = multiToolProvider([
      { id: 'a', name: 'slow-a', input: {} },
      { id: 'b', name: 'slow-b', input: {} },
    ]);
    const { events, elapsed, tmp } = await runLoop(provider, [delayTool('slow-a', 150), delayTool('slow-b', 150)]);
    try {
      const results = events.filter(e => e.type === 'tool_result');
      expect(results.length).toBe(2);
      expect(elapsed).toBeLessThan(280);
      expect(events.at(-1)?.type).toBe('finish');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('失败不中断（allSettled）：一个失败一个成功，两个结果都回填', async () => {
    const provider = multiToolProvider([
      { id: 'a', name: 'bad', input: {} },
      { id: 'b', name: 'good', input: {} },
    ]);
    const { events, tmp } = await runLoop(provider, [delayTool('bad', 30, true), delayTool('good', 60)]);
    try {
      const results = events.filter(e => e.type === 'tool_result');
      expect(results.length).toBe(2);
      const ids = results.map(r => (r as { call: { id: string } }).call.id).sort();
      expect(ids).toEqual(['a', 'b']);
      const bad = results.find(r => (r as { call: { id: string } }).call.id === 'a') as { isError: boolean };
      const good = results.find(r => (r as { call: { id: string } }).call.id === 'b') as { isError: boolean };
      expect(bad.isError).toBe(true);
      expect(good.isError).toBe(false);
      expect(events.at(-1)?.type).toBe('finish'); // 失败不致命，Loop 照常收尾
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('并发审批：两个 ask 工具的 approve 各自到达，两卡均放行', async () => {
    const provider = multiToolProvider([
      { id: 'a', name: 'risky-a', input: {} },
      { id: 'b', name: 'risky-b', input: {} },
    ]);
    const asked: string[] = [];
    const { events, tmp } = await runLoop(
      provider,
      [delayTool('risky-a', 20), delayTool('risky-b', 20)].map(t => ({ ...t, risk: 'high' as const })),
      async call => { asked.push(call.id); return 'once'; },
    );
    try {
      expect(asked.sort()).toEqual(['a', 'b']); // 两个审批都被问到
      const approved = events.filter(e => e.type === 'tool_approved');
      expect(approved.length).toBe(2);
      const results = events.filter(e => e.type === 'tool_result');
      expect(results.length).toBe(2);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('env 回退：WATER_PARALLEL_TOOLS=0 恢复串行（总耗时 ≥ 串行和）', async () => {
    process.env.WATER_PARALLEL_TOOLS = '0';
    const provider = multiToolProvider([
      { id: 'a', name: 'slow-a', input: {} },
      { id: 'b', name: 'slow-b', input: {} },
    ]);
    const { events, elapsed, tmp } = await runLoop(provider, [delayTool('slow-a', 120), delayTool('slow-b', 120)]);
    try {
      expect(events.filter(e => e.type === 'tool_result').length).toBe(2);
      expect(elapsed).toBeGreaterThanOrEqual(235); // 串行：120+120（留调度余量）
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('并发子代理：同轮两个 task，子事件按各自 callId 命名空间透传', async () => {
    // 父循环一轮派两个 task；每个子代理（mock 剧本 m15-sub）请求 write（触发子级审批）
    const provider = new (class implements Provider {
      readonly protocol = 'openai' as const;
      async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
        const isSub = !req.tools?.some(t => t.name === 'task');
        const hasToolResult = req.messages.some(m => m.role === 'tool');
        if (isSub) {
          if (!hasToolResult) {
            yield { type: 'tool_use', call: { type: 'tool_use', id: `sw-${Math.random().toString(36).slice(2, 6)}`, name: 'write', input: { path: 'm27-sub.txt', content: 'sub' } } };
            yield { type: 'done', stopReason: 'tool_use' };
          } else {
            yield { type: 'text_delta', text: '子代理完成' };
            yield { type: 'done', stopReason: 'end' };
          }
          return;
        }
        if (!hasToolResult) {
          yield { type: 'tool_use', call: { type: 'tool_use', id: 'p-1', name: 'task', input: { prompt: '任务 1', mode: 'write' } } };
          yield { type: 'tool_use', call: { type: 'tool_use', id: 'p-2', name: 'task', input: { prompt: '任务 2', mode: 'write' } } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: '父级收尾' };
          yield { type: 'done', stopReason: 'end' };
        }
      }
    })();
    const subApprovals: string[] = [];
    const { events, tmp } = await runLoop(
      provider, builtinTools,
      // 审批桥：子级 write（callId 带父命名空间前缀 p-1:/p-2:）与 task 本身都放行
      async call => {
        subApprovals.push(call.id);
        return 'once';
      },
      new PermissionEngine({ autoAllowLowRisk: true }),
    );
    try {
      const taskResults = events.filter(e => e.type === 'tool_result' && (e as { call?: { name?: string } }).call?.name === 'task');
      expect(taskResults.length).toBe(2); // 两个子代理都完成
      // 子级审批的 callId 命名空间隔离（M15 在并发下的自然成立）
      const namespaced = subApprovals.filter(id => id.startsWith('p-1:') || id.startsWith('p-2:'));
      expect(namespaced.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(path.join(tmp, 'm27-sub.txt'))).toBe(true);
      expect(readFileSync(path.join(tmp, 'm27-sub.txt'), 'utf8')).toBe('sub');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it('mock 剧本 [[mock:parallel]]：一轮两个 write 并发完成（E2E 同款场景单测版）', async () => {
    const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: '[[mock:parallel]] 并发写两个文件' }] }];
    const tmp = mkdtempSync(path.join(tmpdir(), 'water-m27p-'));
    const events = [];
    try {
      for await (const ev of agentLoop({
        provider: new MockProvider(), model: 'mock', system: 'SYS', messages,
        tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
        toolCtx: { cwd: tmp }, maxTurns: 6,
        approve: async () => 'once',
      })) events.push(ev);
      expect(events.filter(e => e.type === 'tool_result').length).toBe(2);
      expect(existsSync(path.join(tmp, 'para-a.txt'))).toBe(true);
      expect(existsSync(path.join(tmp, 'para-b.txt'))).toBe(true);
      expect(events.at(-1)?.type).toBe('finish');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
