/**
 * 客户端视图模型：把 LoopEvent 流折叠成可渲染的块序列。
 * 纯函数，方便测试与复用。
 */
import type { LoopEvent, ToolUsePart, WMessage } from '@water/core';
import type { ApprovalRequiredEvent, QueuedEvent, ServerEvent } from '../api';

export type ToolStatus = 'running' | 'waiting' | 'done' | 'error' | 'denied';

export type UiBlock =
  | { kind: 'user'; text: string; ts?: number }
  | { kind: 'text'; text: string; ts?: number }
  | { kind: 'thinking'; text: string; ts?: number }
  | { kind: 'notice'; text: string; ts?: number }
  | {
    kind: 'tool'; call: ToolUsePart; status: ToolStatus; result?: string; durationMs?: number; ts?: number;
    /** M12：子代理过程（sub_event 折叠出的实时记录） */
    subText?: string;
    subTurns?: number;
    subTools?: Array<{ name: string; ok: boolean | null }>;
    /** M15：子级审批（sub_event 嵌套的 approval_required 及后续状态；fullId = 命名空间 callId） */
    subApprovals?: Array<{ fullId: string; name: string; summary: string; status: 'waiting' | 'approved' | 'denied' }>;
  };

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
        text: ev.method === 'summary'
          ? `🧠 上下文已摘要压缩：${ev.estBefore} → ${ev.estAfter} token（${ev.droppedMessages} 条旧消息总结为要点${ev.summaryTokens ? `，摘要成本 ${ev.summaryTokens} tok` : ''}）`
          : `🗜 上下文已压缩：${ev.estBefore} → ${ev.estAfter} token（丢弃 ${ev.droppedMessages} 条旧消息${ev.truncatedResults ? `，截断 ${ev.truncatedResults} 条工具结果` : ''}）`,
        ts: Date.now(),
      });
      break;
    case 'queued':
      next.push({
        kind: 'notice',
        text: `⏳ 已排队（第 ${(ev as QueuedEvent).position} 位）——前一条处理完后自动执行`,
        ts: Date.now(),
      });
      break;
    case 'sub_event': {
      // M12：子代理事件折叠进对应 task 工具卡（文本累积 / 工具时间线 / 轮次计数）
      // M15：嵌套的 approval_required 记为子级审批；tool_approved/tool_denied 收拢其状态
      return next.map(b => {
        if (b.kind !== 'tool' || b.call.id !== ev.callId) return b;
        const inner = ev.ev as LoopEvent;
        const sub = {
          subText: b.subText ?? '',
          subTurns: b.subTurns ?? 0,
          subTools: [...(b.subTools ?? [])],
          subApprovals: [...(b.subApprovals ?? [])],
        };
        const approvalIdx = (subId: string) =>
          sub.subApprovals.findIndex(a => a.fullId === `${ev.callId}:${subId}`);
        switch (inner.type) {
          case 'turn_start': sub.subTurns++; break;
          case 'text_delta': sub.subText += inner.text; break;
          case 'tool_result': sub.subTools.push({ name: inner.call.name, ok: !inner.isError }); break;
          case 'tool_denied': {
            sub.subTools.push({ name: inner.call.name, ok: null });
            const i = approvalIdx(inner.call.id);
            if (i >= 0) sub.subApprovals[i] = { ...sub.subApprovals[i]!, status: 'denied' };
            break;
          }
          case 'tool_approved': {
            const i = approvalIdx(inner.call.id);
            if (i >= 0) sub.subApprovals[i] = { ...sub.subApprovals[i]!, status: 'approved' };
            break;
          }
          default:
            if ((inner as { type: string }).type === 'approval_required') {
              const a = inner as unknown as ApprovalRequiredEvent;
              const p = a.call.input?.path;
              sub.subApprovals.push({
                fullId: a.callId,
                name: a.call.name,
                summary: typeof p === 'string' ? p : JSON.stringify(a.call.input ?? {}).slice(0, 60),
                status: 'waiting',
              });
            }
            break; // thinking/usage/compacted 等暂不展开
        }
        return { ...b, ...sub };
      });
    }
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
