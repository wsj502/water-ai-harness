/**
 * M9 摘要压缩测试：LLM 摘要优先 → 失败回退确定性；开关语义。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  agentLoop, builtinTools, PermissionEngine, splitForSummary,
  type ChatRequest, type Provider, type StreamEvent, type WMessage,
} from '../packages/core/src/index.js';

const SUMMARY_MARK = '[此前对话的摘要';

/** 双角色 provider：system 含「压缩器」→ 摘要请求；否则主对话（单轮作答） */
class SummarizingProvider implements Provider {
  readonly protocol = 'openai' as const;
  summarizeCalls = 0;
  failSummary = false;
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const sys = req.messages.find(m => m.role === 'system');
    const isSummary = sys?.parts.some(p => p.type === 'text' && p.text.includes('压缩器')) ?? false;
    if (isSummary) {
      this.summarizeCalls++;
      if (this.failSummary) {
        yield { type: 'error', error: new Error('summary endpoint down') };
        return;
      }
      yield { type: 'text_delta', text: '要点：任务是修复登录 bug；已定位 src/auth.ts；待验证。' };
      yield { type: 'done', stopReason: 'end' };
      return;
    }
    yield { type: 'text_delta', text: '好的' };
    yield { type: 'done', stopReason: 'end' };
  }
}

function longHistory(): WMessage[] {
  return [
    { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
    ...Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: `任务问题${i} ${'细节'.repeat(80)}` },
      ],
    })),
  ].map((m, i) => i === 0 ? m : m) as WMessage[];
}

describe('splitForSummary', () => {
  it('保留最近两个完整轮次（从倒数第二个 user 起）', () => {
    const msgs: WMessage[] = [
      { role: 'system', parts: [{ type: 'text', text: 'S' }] },
      { role: 'user', parts: [{ type: 'text', text: 'u1' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'a1' }] },
      { role: 'user', parts: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'a2' }] },
      { role: 'user', parts: [{ type: 'text', text: 'u3' }] },
    ];
    const s = splitForSummary(msgs)!;
    expect(s.head).toHaveLength(1);
    expect(s.old.map(m => (m.parts[0] as { text: string }).text)).toEqual(['u1', 'a1']);
    expect(s.kept.map(m => (m.parts[0] as { text: string }).text)).toEqual(['u2', 'a2', 'u3']);
    // kept 首条非 system 是 user（协议合法）
    expect(s.kept[0]!.role).toBe('user');
  });
  it('用户消息不足 2 条 → null', () => {
    expect(splitForSummary([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }])).toBeNull();
  });
});

describe('agentLoop × 摘要压缩', () => {
  it('超预算 → LLM 摘要替换旧轮次，事件带 method=summary 与成本', async () => {
    const p = new SummarizingProvider();
    const messages = longHistory();
    const events = [];
    for await (const ev of agentLoop({
      provider: p, model: 'm', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxContextTokens: 600,
    })) events.push(ev);

    expect(p.summarizeCalls).toBeGreaterThanOrEqual(1);
    const ev = events.find(e => e.type === 'compacted' && e.method === 'summary');
    expect(ev).toBeDefined();
    expect(ev!.type === 'compacted' && ev!.summaryTokens).toBeGreaterThan(0);
    // 摘要消息就位且结构合法
    const summaryMsg = messages.find(m =>
      m.role === 'user' && m.parts.some(pp => pp.type === 'text' && pp.text.includes(SUMMARY_MARK)));
    expect(summaryMsg).toBeDefined();
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('user');
    // 对话未被摘要失败中断
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'end' });
  });

  it('摘要失败 → 回退确定性裁剪，会话不中断', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new SummarizingProvider();
    p.failSummary = true;
    const messages = longHistory();
    const events = [];
    for await (const ev of agentLoop({
      provider: p, model: 'm', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxContextTokens: 600,
    })) events.push(ev);

    expect(p.summarizeCalls).toBeGreaterThanOrEqual(1); // 尝试过
    const trunc = events.find(e => e.type === 'compacted' && e.method === 'truncate');
    expect(trunc).toBeDefined(); // 回退生效
    const summ = events.find(e => e.type === 'compacted' && e.method === 'summary');
    expect(summ).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'end' });
    errSpy.mockRestore();
  });

  it('compactSummarize=false → 直接确定性路径（不调摘要）', async () => {
    const p = new SummarizingProvider();
    const messages = longHistory();
    const events = [];
    for await (const ev of agentLoop({
      provider: p, model: 'm', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxContextTokens: 600, compactSummarize: false,
    })) events.push(ev);
    expect(p.summarizeCalls).toBe(0);
    expect(events.some(e => e.type === 'compacted' && e.method === 'truncate')).toBe(true);
  });
});
