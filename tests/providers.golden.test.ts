/**
 * Provider 翻译层 golden 测试（M4）：双协议「请求侧翻译 + 响应侧解析」帧级锁定。
 *
 * 这是协议正确性的咽喉测试——WMessage ↔ Anthropic/OpenAI 的任何一次
 * 不经意重构，这里都会立刻变红。全部离线：fetch 被 mock，SSE 流手工构造。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, OpenAIProvider } from '../packages/core/src/providers/index.js';
import type { StreamEvent, ToolSpec, WMessage } from '../packages/core/src/types.js';

// ---------- 工具：mock fetch / 构造 SSE ----------

interface FetchCall { url: string; headers: Record<string, string>; body: unknown }

let calls: FetchCall[] = [];
let nextResponse: () => Response;

function mockFetch(respFactory: () => Response): void {
  calls = [];
  nextResponse = respFactory;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return nextResponse();
  }) as typeof fetch;
}

/** 把 SSE 帧数组变成流式 Response（一次 chunk 到位——解析器不在乎分片边界） */
function sse(frames: string[]): Response {
  return new Response(
    new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(frames.join('')));
        ctrl.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

// ---------- 公共夹具：一条完整的混合历史 ----------

const HISTORY: WMessage[] = [
  { role: 'system', parts: [{ type: 'text', text: 'SYS-PROMPT' }] },
  { role: 'user', parts: [{ type: 'text', text: '读一下 a.ts' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'thinking', text: '应该用 read 工具' },
      { type: 'text', text: '我来读。' },
      { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a.ts' } },
    ],
  },
  { role: 'tool', parts: [{ type: 'tool_result', toolUseId: 'tu_1', content: '1: hello', isError: true }] },
];

const TOOLS: ToolSpec[] = [{
  name: 'read', description: '读文件',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

async function collect(gen: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ================= Anthropic =================

describe('Anthropic 请求侧翻译', () => {
  it('system 抽顶层 / thinking 不回传 / tool_result 走 user 消息 / 鉴权头', async () => {
    mockFetch(() => sse(['event: message_stop\n\n']));
    const p = new AnthropicProvider({ protocol: 'anthropic', baseUrl: 'https://api.test', apiKey: 'sk-ant-x' });
    await collect(p.chat({ model: 'glm-4.6', messages: HISTORY, tools: TOOLS }));

    expect(calls).toHaveLength(1);
    const { url, headers, body } = calls[0]!;
    expect(url).toBe('https://api.test/v1/messages');
    expect(headers['x-api-key']).toBe('sk-ant-x');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const b = body as Record<string, any>;
    expect(b.system).toBe('SYS-PROMPT');            // system 抽顶层
    expect(b.stream).toBe(true);
    expect(b.tools[0]).toMatchObject({ name: 'read', input_schema: { type: 'object' } });

    const msgs = b.messages as Array<{ role: string; content: Array<Record<string, string>> }>;
    expect(msgs[0]!.role).toBe('user');
    // assistant 消息：thinking 块被丢弃，只剩 text + tool_use
    const a = msgs[1]!;
    expect(a.role).toBe('assistant');
    expect(a.content.map(c => c.type)).toEqual(['text', 'tool_use']);
    // tool 消息 → user 角色包 tool_result 块（含 is_error）
    const t = msgs[2]!;
    expect(t.role).toBe('user');
    expect(t.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', is_error: true });
  });
});

describe('Anthropic 响应侧解析', () => {
  it('text/tool_use 增量聚合，usage 读 message_delta（智谱兼容），stopReason 映射', async () => {
    mockFetch(() => sse([
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"世界"}}\n\n',
      'event: content_block_stop\ndata: {"index":0}\n\n',
      'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"tu_9","name":"read"}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"th\\":\\"a.ts\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"index":1}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42,"input_tokens":100}}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]));
    const p = new AnthropicProvider({ protocol: 'anthropic', baseUrl: 'https://api.test', apiKey: 'k' });
    const evs = await collect(p.chat({ model: 'm', messages: HISTORY, tools: TOOLS }));

    expect(evs.filter(e => e.type === 'text_delta').map(e => (e as any).text)).toEqual(['你好', '世界']);
    const tu = evs.find(e => e.type === 'tool_use') as Extract<StreamEvent, { type: 'tool_use' }>;
    expect(tu.call).toMatchObject({ id: 'tu_9', name: 'read', input: { path: 'a.ts' } }); // 碎片拼装
    expect(evs.find(e => e.type === 'usage')).toMatchObject({ inputTokens: 100, outputTokens: 42 });
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' });
  });
});

// ================= OpenAI 兼容 =================

describe('OpenAI 请求侧翻译', () => {
  it('system 内嵌 messages[0] / tool_calls 结构 / role:tool 一对一 / Bearer 头', async () => {
    mockFetch(() => sse(['data: [DONE]\n\n']));
    const p = new OpenAIProvider({ protocol: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'sk-oai' });
    await collect(p.chat({ model: 'deepseek-chat', messages: HISTORY, tools: TOOLS }));

    expect(calls[0]!.url).toBe('https://api.test/v1/chat/completions');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-oai');

    const msgs = (calls[0]!.body as any).messages as Array<Record<string, any>>;
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'SYS-PROMPT' }); // 内嵌而非顶层
    expect(msgs[1]).toMatchObject({ role: 'user', content: '读一下 a.ts' });
    const a = msgs[2]!;
    expect(a.role).toBe('assistant');
    expect(a.content).toBe('我来读。');
    expect(a.tool_calls[0]).toEqual({
      id: 'tu_1', type: 'function',
      function: { name: 'read', arguments: '{"path":"a.ts"}' },
    });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '1: hello' });
    expect((calls[0]!.body as any).tools[0]).toMatchObject({
      type: 'function', function: { name: 'read', parameters: { type: 'object' } },
    });
  });
});

describe('OpenAI 响应侧解析', () => {
  it('content/reasoning_content/tool_calls 碎片按 index 聚合，usage 与 finish_reason', async () => {
    mockFetch(() => sse([
      'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"回答"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"b.ts\\"}"}},{"index":1,"id":"c2","function":{"name":"glob","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]));
    const p = new OpenAIProvider({ protocol: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'k' });
    const evs = await collect(p.chat({ model: 'm', messages: HISTORY, tools: TOOLS }));

    expect(evs.some(e => e.type === 'thinking_delta' && (e as any).text === '想一想')).toBe(true);
    expect(evs.some(e => e.type === 'text_delta' && (e as any).text === '回答')).toBe(true);
    const tus = evs.filter(e => e.type === 'tool_use') as Array<Extract<StreamEvent, { type: 'tool_use' }>>;
    expect(tus.map(t => t.call.name)).toEqual(['read', 'glob']);      // index 顺序
    expect(tus[0]!.call.input).toEqual({ path: 'b.ts' });             // 跨帧拼装
    expect(tus[1]!.call.id).toBe('c2');
    expect(evs.find(e => e.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' });
  });

  it('缺失 finish_reason 但有 tool_calls → 语义修正为 tool_use', async () => {
    mockFetch(() => sse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const p = new OpenAIProvider({ protocol: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'k' });
    const evs = await collect(p.chat({ model: 'm', messages: HISTORY, tools: TOOLS }));
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' });
  });

  it('finish_reason=stop → end 映射', async () => {
    mockFetch(() => sse([
      'data: {"choices":[{"delta":{"content":"完"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const p = new OpenAIProvider({ protocol: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'k' });
    const evs = await collect(p.chat({ model: 'm', messages: HISTORY, tools: TOOLS }));
    expect(evs.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' });
  });
});
