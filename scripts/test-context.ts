/**
 * M2 离线测试：上下文管理器 + 容错重试（零凭据，零网络）。
 *
 * 运行：npx tsx scripts/test-context.ts
 *
 * 覆盖：
 *   1. token 估算器的量级正确性（CJK vs ASCII）
 *   2. compactMessages：预算内 no-op / 裁旧 tool_result / 丢最旧轮次 + 结构合法性
 *   3. agentLoop 集成：超预算时发 compacted 事件，且模型可见的历史首条非 system 为 user
 *   4. fetchWithRetry：429×2 → 第 3 次成功（退避真实生效）；已中断信号直接抛出不重试
 */
import {
  agentLoop, builtinTools, compactMessages, estimateMessagesTokens, estimateTokens,
  fetchWithRetry, PermissionEngine,
  type ChatRequest, type Provider, type StreamEvent, type WMessage,
} from '../packages/core/src/index.js';

let failed = 0;
function ok(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

function user(text: string): WMessage { return { role: 'user', parts: [{ type: 'text', text }] }; }
function assistant(text: string): WMessage { return { role: 'assistant', parts: [{ type: 'text', text }] }; }
function toolMsg(id: string, content: string): WMessage {
  return { role: 'tool', parts: [{ type: 'tool_result', toolUseId: id, content }] };
}

// ---------- 1. 估算器 ----------
console.log('--- token 估算器 ---');
ok(estimateTokens('你好世界') === 4, 'CJK ≈ 1 token/字');
ok(estimateTokens('hello world') === Math.ceil(11 / 3.8), 'ASCII ≈ 3.8 字符/token');
ok(estimateTokens('你好 hello') > estimateTokens('hello'), '混合文本高于纯 ASCII');

// ---------- 2. compactMessages ----------
console.log('--- compactMessages ---');
{
  const msgs = [
    { role: 'system', parts: [{ type: 'text', text: 'SYS' }] } as WMessage,
    user('第一问'),
    assistant('第一答'),
    user('第二问'),
    assistant('第二答'),
    user('第三问'),
  ];
  const r = compactMessages(msgs, estimateMessagesTokens(msgs));
  ok(!r.compacted, '预算内 no-op');
  ok(msgs.length === 6, 'no-op 不改消息');
}
{
  const long = 'A'.repeat(2000);
  const msgs: WMessage[] = [
    { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
    user('旧问题一'),
    { role: 'assistant', parts: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } }] },
    toolMsg('t1', long),
    assistant('旧结论'),
    user('第二问'),
    assistant('第二答'),
    user('最新问题'),
  ];
  const r = compactMessages(msgs, estimateMessagesTokens(msgs) - 50);
  ok(r.compacted, '超预算触发压缩');
  ok(r.truncatedResults === 1, `旧 tool_result 被截断（实际 ${r.truncatedResults}）`);
  const tr = msgs.flatMap(m => m.parts).find(p => p.type === 'tool_result');
  ok(tr !== undefined && tr.type === 'tool_result' && tr.content.includes('上下文压缩'), '截断带占位标记');
}
{
  const msgs: WMessage[] = [
    { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
    ...Array.from({ length: 12 }, (_, i) => user(`问题${i}${'x'.repeat(400)}`)),
  ];
  const r = compactMessages(msgs, 500);
  ok(r.compacted && r.droppedMessages >= 7, `小预算丢最旧轮次（丢弃 ${r.droppedMessages} 条）`);
  ok(msgs[0]!.role === 'system', 'system 永不丢');
  ok(msgs[1]!.role === 'user', '压缩后首条非 system 消息是 user（协议合法性）');
  ok(estimateMessagesTokens(msgs) <= 500 || msgs.length <= 5, '入预算或到保留下限');
}
{
  // 孤儿 tool_result 清退：丢掉 user 后紧跟的 assistant/tool 必须一并清
  const msgs: WMessage[] = [
    { role: 'system', parts: [{ type: 'text', text: 'SYS' }] },
    user('旧1'),
    { role: 'assistant', parts: [{ type: 'tool_use', id: 't9', name: 'grep', input: {} }] },
    toolMsg('t9', 'r'.repeat(100)),
    user('新1'),
    assistant('答'),
  ];
  const r = compactMessages(msgs, 60);
  ok(msgs[1]!.role === 'user', '孤儿 tool 消息被清退（首条仍是 user）');
  ok(r.droppedMessages >= 3, `实际丢弃 ${r.droppedMessages} 条`);
}

// ---------- 3. agentLoop 集成 ----------
console.log('--- agentLoop × 压缩 ---');
{
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
    provider: prov, model: 'test', system: 'SYS', messages,
    tools: builtinTools, permissions: new PermissionEngine({ autoAllowLowRisk: true }),
    toolCtx: { cwd: process.cwd() }, maxContextTokens: 400,
  })) events.push(ev as { type: string });

  ok(events.some(e => e.type === 'compacted'), 'Loop 发出 compacted 事件');
  ok(seen[0]![0]!.role === 'system' && seen[0]![1]!.role === 'user', '模型看到的历史首条非 system 为 user');
  ok(seen[0]!.length < 11, `历史被压缩（${seen[0]!.length} 条）`);
  ok(events.at(-1)!.type === 'finish', '会话正常结束');
}

// ---------- 4. fetchWithRetry ----------
console.log('--- fetchWithRetry ---');
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  const sse = (payload: string) => new Response(
    new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(payload));
        ctrl.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= 2) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    return sse('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;

  try {
    const resp = await fetchWithRetry('https://mock.test/v1', { method: 'POST' }, { maxRetries: 3 });
    ok(resp.status === 200, '429×2 后第 3 次成功');
    ok(calls === 3, `fetch 恰好调用 3 次（实际 ${calls}）`);
    const text = await resp.text();
    ok(text.includes('pong'), '响应体完好');
  } finally {
    globalThis.fetch = realFetch;
  }
}
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  // 模拟真实 fetch 语义：signal 已中止 → 抛 AbortError（而不是返回响应）
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls++;
    if (init?.signal?.aborted) {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    return new Response('x', { status: 500 });
  }) as typeof fetch;
  const ac = new AbortController(); ac.abort();
  const warn = console.warn; console.warn = () => {};
  try {
    await fetchWithRetry('https://mock.test/v1', { method: 'POST' }, { signal: ac.signal });
    ok(false, '已中断信号应直接抛出');
  } catch {
    ok(calls === 1, `中断不重试（fetch ${calls} 次）`);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = warn;
  }
}

console.log(`\n${failed === 0 ? '✅ M2 上下文/重试 测试 PASS' : `❌ FAIL（${failed} 项）`}`);
if (failed > 0) process.exit(1);
