/**
 * Anthropic Messages 协议适配器（/v1/messages）。
 * 适用：智谱 GLM coding plan（open.bigmodel.cn/api/anthropic）、Claude 官方。
 *
 * 翻译要点：
 * - system 从 messages 里抽出，放到顶层 system 字段
 * - thinking part 不回传（历史里的思考块对后续推理无用，且官方要求带 signature）
 * - tool_use → content block {type:'tool_use'}
 * - tool_result → 包进一条 user 消息的 content（Anthropic 没有 role:'tool'）
 */
import type {
  ChatRequest, Provider, ProviderConfig, StreamEvent,
  WMessage, ToolSpec, Part,
} from '../types.js';
import { parseSSE } from './sse.js';

// ---------- 请求侧：WMessage → Anthropic ----------

interface AnthropicBlock {
  type: string;
  [k: string]: unknown;
}

function toAnthropicMessage(m: WMessage): { role: 'user' | 'assistant'; content: AnthropicBlock[] } | null {
  const content: AnthropicBlock[] = [];
  for (const p of m.parts) {
    switch (p.type) {
      case 'text':
        content.push({ type: 'text', text: p.text });
        break;
      case 'thinking':
        break; // 不回传思考块，见文件头注释
      case 'tool_use':
        content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input });
        break;
      case 'tool_result':
        content.push({
          type: 'tool_result', tool_use_id: p.toolUseId, content: p.content,
          ...(p.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  if (content.length === 0) return null;
  // Anthropic 里工具结果必须走 user 角色
  const role = m.role === 'tool' ? 'user' : m.role;
  if (role !== 'user' && role !== 'assistant') return null;
  return { role, content };
}

function toAnthropicTools(tools: ToolSpec[]): unknown[] {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

// ---------- 响应侧：Anthropic SSE → StreamEvent ----------

interface BlockState {
  type: 'text' | 'thinking' | 'tool_use';
  id?: string;
  name?: string;
  jsonBuf: string;
}

export class AnthropicProvider implements Provider {
  readonly protocol = 'anthropic' as const;
  constructor(private config: ProviderConfig) {}

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const system = req.messages
      .filter(m => m.role === 'system')
      .flatMap(m => m.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text'))
      .map(p => p.text).join('\n');

    const messages = req.messages
      .filter(m => m.role !== 'system')
      .map(toAnthropicMessage)
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const resp = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? 8192,
        ...(system ? { system } : {}),
        messages,
        ...(req.tools?.length ? { tools: toAnthropicTools(req.tools) } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: true,
      }),
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => '');
      yield { type: 'error', error: new Error(`Anthropic ${resp.status}: ${text.slice(0, 300)}`) };
      return;
    }

    const blocks = new Map<number, BlockState>();
    let inputTokens = 0, outputTokens = 0;
    let stopReason: string = 'unknown';

    for await (const ev of parseSSE(resp.body)) {
      let j: Record<string, unknown>;
      try { j = JSON.parse(ev.data); } catch { continue; }

      switch (ev.event) {
        case 'message_start': {
          const usage = (j.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
          if (usage?.input_tokens) inputTokens = usage.input_tokens;
          break;
        }
        case 'content_block_start': {
          const i = j.index as number;
          const cb = j.content_block as Record<string, unknown>;
          if (cb.type === 'tool_use') {
            blocks.set(i, { type: 'tool_use', id: cb.id as string, name: cb.name as string, jsonBuf: '' });
          } else if (cb.type === 'thinking') {
            blocks.set(i, { type: 'thinking', jsonBuf: '' });
          } else {
            blocks.set(i, { type: 'text', jsonBuf: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const i = j.index as number;
          const delta = j.delta as Record<string, unknown>;
          const st = blocks.get(i);
          if (!st) break;
          if (delta.type === 'text_delta') yield { type: 'text_delta', text: delta.text as string };
          else if (delta.type === 'thinking_delta') yield { type: 'thinking_delta', text: delta.thinking as string };
          else if (delta.type === 'input_json_delta') st.jsonBuf += delta.partial_json as string;
          break;
        }
        case 'content_block_stop': {
          const i = j.index as number;
          const st = blocks.get(i);
          if (st?.type === 'tool_use') {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(st.jsonBuf || '{}'); } catch { /* 容错：非法 JSON 按空调用 */ }
            yield { type: 'tool_use', call: { type: 'tool_use', id: st.id!, name: st.name!, input } };
          }
          blocks.delete(i);
          break;
        }
        case 'message_delta': {
          const d = j.delta as Record<string, unknown> | undefined;
          if (d?.stop_reason) stopReason = d.stop_reason as string;
          const usage = j.usage as Record<string, number> | undefined;
          if (usage?.output_tokens) outputTokens = usage.output_tokens;
          // 智谱端点在 message_start 里报 0，真实值在 message_delta（与官方行为不同，实测确认）
          if (usage?.input_tokens) inputTokens = usage.input_tokens;
          break;
        }
        case 'message_stop': break;
        case 'error':
          yield { type: 'error', error: new Error(`stream error: ${ev.data.slice(0, 300)}`) };
          return;
      }
    }

    yield { type: 'usage', inputTokens, outputTokens };
    yield {
      type: 'done',
      stopReason: stopReason === 'end_turn' ? 'end'
        : stopReason === 'tool_use' ? 'tool_use'
        : stopReason === 'max_tokens' ? 'max_tokens' : 'unknown',
    };
  }
}
