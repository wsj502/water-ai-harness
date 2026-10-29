/**
 * OpenAI 兼容协议适配器（/chat/completions）。
 * 适用：DeepSeek、通义千问、本地 vLLM/Ollama 等一切 OpenAI 兼容端点。
 *
 * 翻译要点：
 * - system 作为 messages[0] 内嵌（OpenAI 没有顶层 system 字段）
 * - tool_use → assistant.tool_calls[]；tool_result → role:'tool' 消息
 * - 推理模型的思考走 delta.reasoning_content（DeepSeek 约定）
 * - 工具参数以 JSON 字符串碎片流式到达，按 index 聚合
 */
import type {
  ChatRequest, Provider, ProviderConfig, StreamEvent,
  WMessage, ToolSpec,
} from '../types.js';
import { parseSSE } from './sse.js';
import { fetchWithRetry } from './retry.js';

// ---------- 请求侧：WMessage → OpenAI ----------

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function toOpenAIMessages(msgs: WMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system' || m.role === 'user') {
      const text = m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n');
      if (text) out.push({ role: m.role, content: text });
    } else if (m.role === 'assistant') {
      const text = m.parts.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n');
      const calls = m.parts.filter(p => p.type === 'tool_use');
      const msg: OpenAIMessage = { role: 'assistant', content: text || null };
      if (calls.length > 0) {
        msg.tool_calls = calls.map(p => {
          const tu = p as Extract<typeof p, { type: 'tool_use' }>;
          return {
            id: tu.id, type: 'function',
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          };
        });
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      // OpenAI 的 tool 消息一对一，不能合并
      for (const p of m.parts) {
        if (p.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: p.toolUseId, content: p.content });
        }
      }
    }
  }
  return out;
}

function toOpenAITools(tools: ToolSpec[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// ---------- 响应侧：OpenAI SSE → StreamEvent ----------

interface ToolCallState { id: string; name: string; argsBuf: string }

export class OpenAIProvider implements Provider {
  readonly protocol = 'openai' as const;
  constructor(private config: ProviderConfig) {}

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const resp = await fetchWithRetry(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        messages: toOpenAIMessages(req.messages),
        ...(req.tools?.length ? { tools: toOpenAITools(req.tools) } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
      ...(req.signal ? { signal: req.signal } : {}),
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      yield { type: 'error', error: new Error(`OpenAI ${resp.status}: ${text.slice(0, 300)}`) };
      return;
    }

    const calls = new Map<number, ToolCallState>();
    let stopReason: string = 'unknown';

    for await (const ev of parseSSE(resp.body)) {
      if (ev.data === '[DONE]') break;
      let j: Record<string, unknown>;
      try { j = JSON.parse(ev.data); } catch { continue; }

      const usage = j.usage as Record<string, number> | undefined;
      if (usage) {
        yield {
          type: 'usage',
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        };
      }

      const choice = (j.choices as Record<string, unknown>[] | undefined)?.[0];
      if (!choice) continue;

      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }
        // DeepSeek 推理模型的思考通道
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          yield { type: 'thinking_delta', text: delta.reasoning_content };
        }
        const tcs = delta.tool_calls as Record<string, unknown>[] | undefined;
        if (tcs) {
          for (const tc of tcs) {
            const i = tc.index as number;
            let st = calls.get(i);
            if (!st) { st = { id: '', name: '', argsBuf: '' }; calls.set(i, st); }
            if (tc.id) st.id = tc.id as string;
            const fn = tc.function as Record<string, unknown> | undefined;
            if (fn?.name) st.name = fn.name as string;
            if (fn?.arguments) st.argsBuf += fn.arguments as string;
          }
        }
      }

      const fr = choice.finish_reason as string | null;
      if (fr) {
        stopReason = fr === 'stop' ? 'end' : fr === 'tool_calls' ? 'tool_use'
          : fr === 'length' ? 'max_tokens' : 'unknown';
      }
    }

    // 流结束时统一发出聚合好的 tool_use
    for (const [, st] of [...calls.entries()].sort(([a], [b]) => a - b)) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(st.argsBuf || '{}'); } catch { /* 容错 */ }
      yield { type: 'tool_use', call: { type: 'tool_use', id: st.id || `call_${Date.now()}`, name: st.name, input } };
    }

    // 有工具调用时 finish_reason 语义修正（部分兼容端点不发 finish_reason）
    if (calls.size > 0 && stopReason !== 'max_tokens') stopReason = 'tool_use';
    yield { type: 'done', stopReason: stopReason as 'end' | 'tool_use' | 'max_tokens' | 'unknown' };
  }
}
