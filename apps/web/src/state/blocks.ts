/**
 * 客户端视图模型：把 LoopEvent 流折叠成可渲染的块序列。
 * 纯函数，方便测试与复用。
 */
import type { LoopEvent, ToolUsePart, WMessage } from '@water/core';
import type { ApprovalRequiredEvent, ServerEvent } from '../api';

export type ToolStatus = 'running' | 'waiting' | 'done' | 'error' | 'denied';

export type UiBlock =
  | { kind: 'user'; text: string; ts?: number }
  | { kind: 'text'; text: string; ts?: number }
  | { kind: 'thinking'; text: string; ts?: number }
  | { kind: 'notice'; text: string; ts?: number }
  | { kind: 'tool'; call: ToolUsePart; status: ToolStatus; result?: string; durationMs?: number; ts?: number };

/** 把 LoopEvent 应用到块序列（返回新数组，供 React setState） */
export function applyEvent(blocks: UiBlock[], ev: ServerEvent): UiBlock[] {
  const next = [...blocks];
  const last = next[next.length - 1];

  switch (ev.type) {
    case 'text_delta':
      if (last?.kind === 'text') {
        next[next.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        next.push({ kind: 'text', text: ev.text, ts: Date.now() });
      }
      break;
    case 'thinking_delta':
      if (last?.kind === 'thinking') {
        next[next.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        next.push({ kind: 'thinking', text: ev.text, ts: Date.now() });
      }
      break;
    case 'tool_pending':
      next.push({ kind: 'tool', call: ev.call, status: 'running', ts: Date.now() });
      break;
    case 'approval_required':
      return next.map(b =>
        b.kind === 'tool' && b.call.id === (ev as ApprovalRequiredEvent).callId
          ? { ...b, status: 'waiting' as ToolStatus } : b);
    case 'tool_approved':
    case 'tool_denied':
    case 'tool_result': {
      return next.map(b => {
        if (b.kind !== 'tool' || b.call.id !== (ev as LoopEvent & { call: ToolUsePart }).call.id) return b;
        if (ev.type === 'tool_approved') return { ...b, status: 'running' as ToolStatus };
        if (ev.type === 'tool_denied') return { ...b, status: 'denied' as ToolStatus };
        return {
          ...b,
          status: ev.isError ? 'error' as ToolStatus : 'done' as ToolStatus,
          result: ev.result, durationMs: ev.durationMs,
        };
      });
    }
    case 'compacted':
      next.push({
        kind: 'notice',
        text: `🗜 上下文已压缩：${ev.estBefore} → ${ev.estAfter} token（丢弃 ${ev.droppedMessages} 条旧消息${ev.truncatedResults ? `，截断 ${ev.truncatedResults} 条工具结果` : ''}）`,
        ts: Date.now(),
      });
      break;
    case 'turn_start':
      break; // 轮次切换天然由块边界表达
    default:
      break;
  }
  return next;
}

/** 从服务端历史消息水合成块序列（切换会话时用） */
export function hydrateBlocks(messages: WMessage[]): UiBlock[] {
  const blocks: UiBlock[] = [];
  const toolIndex = new Map<string, number>();

  for (const m of messages) {
    if (m.role === 'system') continue;
    for (const p of m.parts) {
      if (m.role === 'user' && p.type === 'text') {
        blocks.push({ kind: 'user', text: p.text });
      } else if (m.role === 'assistant') {
        if (p.type === 'text') blocks.push({ kind: 'text', text: p.text });
        else if (p.type === 'thinking') blocks.push({ kind: 'thinking', text: p.text });
        else if (p.type === 'tool_use') {
          toolIndex.set(p.id, blocks.length);
          blocks.push({ kind: 'tool', call: p, status: 'running' });
        }
      } else if (m.role === 'tool' && p.type === 'tool_result') {
        const i = toolIndex.get(p.toolUseId);
        const b = i !== undefined ? blocks[i] : undefined;
        if (i !== undefined && b?.kind === 'tool') {
          blocks[i] = {
            ...b,
            status: p.isError ? 'error' : 'done',
            result: p.content,
          };
        }
      }
    }
  }
  return blocks;
}
