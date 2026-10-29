/**
 * 上下文管理器 + 容错网关（迁移自 scripts/test-context.ts，断言语义不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentLoop, builtinTools, compactMessages, estimateMessagesTokens, estimateTokens,
  fetchWithRetry, PermissionEngine,
  type ChatRequest, type Provider, type StreamEvent, type WMessage,
} from '../packages/core/src/index.js';

const user = (text: string): WMessage => ({ role: 'user', parts: [{ type: 'text', text }] });
const assistant = (text: string): WMessage => ({ role: 'assistant', parts: [{ type: 'text', text }] });
const toolMsg = (id: string, content: string): WMessage =>
  ({ role: 'tool', parts: [{ type: 'tool_result', toolUseId: id, content }] });

describe('token 估算器', () => {
  it('CJK ≈ 1 token/字', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });
  it('ASCII ≈ 3.8 字符/token', () => {
    expect(estimateTokens('hello world')).toBe(Math.ceil(11 / 3.8));
  });
  it('混合文本高于纯 ASCII', () => {
    expect(estimateTokens('你好 hello')).toBeGreaterThan(estimateTokens('hello'));
  });
});

describe('compactMessages', () => {
  it('预算内 no-op，不改消息', () => {
    const msgs = [
      { role: 'system', parts: [{ type: 'text', text: 'SYS' }] } as WMessage,
      user('第一问'), assistant('第一答'), user('第二问'), assistant('第二答'), user('第三问'),
    ];
    const r = compactMessages(msgs, estimateMessagesTokens(msgs));
    expect(r.compacted).toBe(false);
    expect(msgs.length).toBe(6);
  });

  it('超预算：先裁旧 tool_result，带占位标记', () => {
    const long = 'A'.repeat(2000);
    const msgs: WMessage[] = [
      { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
      user('旧问题一'),
      { role: 'assistant', parts: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }] },
      toolMsg('t1', long),
      assistant('旧结论'), user('第二问'), assistant('第二答'), user('最新问题'),
    ];
    const r = compactMessages(msgs, estimateMessagesTokens(msgs) - 50);
    expect(r.compacted).toBe(true);
    expect(r.truncatedResults).toBe(1);
    const tr = msgs.flatMap(m => m.parts).find(p => p.type === 'tool_result');
    expect(tr).toBeDefined();
    expect(tr!.type === 'tool_result' && tr!.content).toContain('上下文压缩');
  });

  it('小预算：丢最旧轮次，system 永不丢，首条非 system 是 user', () => {
    const msgs: WMessage[] = [
      { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
      ...Array.from({ length: 12 }, (_, i) => user(`问题${i}${'x'.repeat(400)}`)),
    ];
    const r = compactMessages(msgs, 500);
    expect(r.compacted).toBe(true);
    expect(r.droppedMessages).toBeGreaterThanOrEqual(7);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]!.role).toBe('user');
    expect(estimateMessagesTokens(msgs) <= 500 || msgs.length <= 5).toBe(true);
  });

  it('孤儿 tool 消息被清退', () => {
    const msgs: WMessage[] = [
      { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
      user('旧1'),
      { role: 'assistant', parts: [{ type: 'tool_use', id: 't9', name: 'grep', input: {} }] },
      toolMsg('t9', 'r'.repeat(100)),
      user('新1'), assistant('答'),
    ];
    const r = compactMessages(msgs, 60);
    expect(msgs[1]!.role).toBe('user');
    expect(r.droppedMessages).toBeGreaterThanOrEqual(3);
  });
});

describe('agentLoop × 上下文压缩', () => {
  it('超预算发 compacted 事件，模型视角历史合法', async () => {
    const seen: WMessage[][] = [];
    const prov: Provider = {
      protocol: 'openai',
      async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
        seen.push(structuredClone(req.messages));
        yield { type: 'text_delta', text: '答' };
        yield { type: 'done', stopReason: 'end' };
      },
    };
    const messages: WMessage[] = [
      { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
      ...Array.from({ length: 10 }, (_, i) => user(`历史${i}${'y'.repeat(300)}`)),
    ];
    const events: Array<{ type: string }> = [];
    for await (const ev of agentLoop({
      provider: prov, model: 't', system: 'SYS', messages,
      tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
      toolCtx: { cwd: process.cwd() }, maxContextTokens: 400,
    })) events.push(ev as { type: string });

    expect(events.some(e => e.type === 'compacted')).toBe(true);
    expect(seen[0]![0]!.role).toBe('system');
    expect(seen[0]![1]!.role).toBe('user');
    expect(seen[0]!.length).toBeLessThan(11);
    expect(events.at(-1)!.type).toBe('finish');
  });
});

describe('fetchWithRetry', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  function sse(payload: string): Response {
    return new Response(
      new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(payload));
          ctrl.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }

  it('429×2 后第 3 次成功，fetch 恰好 3 次', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls <= 2) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
      return sse('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
    }) as typeof fetch;

    const resp = await fetchWithRetry('https://mock.test/v1', { method: 'POST' }, { maxRetries: 3 });
    expect(resp.status).toBe(200);
    expect(calls).toBe(3);
    expect(await resp.text()).toContain('pong');
  });

  it('已中断信号直接抛出，不重试', async () => {
    let calls = 0;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      calls++;
      if (init?.signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return new Response('x', { status: 500 });
    }) as typeof fetch;

    const ac = new AbortController();
    ac.abort();
    await expect(fetchWithRetry('https://mock.test/v1', { method: 'POST' }, { signal: ac.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('持续 500 达到重试上限后返回最后响应', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('boom', { status: 500 }); }) as typeof fetch;
    const resp = await fetchWithRetry('https://mock.test/v1', { method: 'POST' }, { maxRetries: 2 });
    expect(resp.status).toBe(500);
    expect(calls).toBe(3); // 首次 + 2 次重试
  });
});
