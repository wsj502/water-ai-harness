/**
 * 客户端视图模型：把 LoopEvent 流折叠成可渲染的块序列。
 * 纯函数，方便测试与复用。
 */
import type { LoopEvent, ToolUsePart, WMessage } from '@water/core';
import type { ApprovalRequiredEvent, QueuedEvent, ServerEvent } from '../api';

/** 参数摘要：展示主参数而非整个 JSON（主工具卡与子代理时间线共用；M18 从 App.tsx 下沉） */
export function argSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (name) {
    case 'read': case 'edit': case 'write': return s(input.path ?? '');
    case 'glob': return s(input.pattern ?? '');
    case 'grep': {
      const inc = input.include ? ` include="${s(input.include)}"` : '';
      return `pattern="${s(input.pattern ?? '')}"${inc}`;
    }
    case 'shell': return s(input.command ?? '');
    case 'task': return s(input.description ?? '') || `研究：${s(input.prompt ?? '').slice(0, 40)}`;
    default: return JSON.stringify(input).slice(0, 120);
  }
}

export type ToolStatus = 'running' | 'waiting' | 'done' | 'error' | 'denied';

/**
 * M18 子代理时间线：一轮一组，组内为按序节点（文本/工具/审批）。
 * 由 sub_event 帧序列确定性折叠——直播与回放同构（同一帧序列重建同一视图）。
 */
export interface SubTimelineTurn {
  turn: number;
  nodes: Array<
    | { kind: 'text'; text: string }
    | { kind: 'tool'; name: string; summary: string; status: 'running' | 'done' | 'error' | 'denied'; result?: string }
    | { kind: 'approval'; fullId: string; name: string; summary: string; status: 'waiting' | 'approved' | 'denied' }
  >;
}

export type UiBlock =
  | { kind: 'user'; text: string; ts?: number }
  | { kind: 'text'; text: string; ts?: number }
  | { kind: 'thinking'; text: string; ts?: number }
  | { kind: 'notice'; text: string; ts?: number }
  | {
    kind: 'tool'; call: ToolUsePart; status: ToolStatus; result?: string; durationMs?: number; ts?: number;
    /** M18：子代理时间线（sub_event 流按轮次折叠；直播与回放同构） */
    subTimeline?: SubTimelineTurn[];
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
    case 'queued': {
      const q = ev as QueuedEvent;
      next.push({
        kind: 'notice',
        text: q.scope === 'global'
          ? `🌐 全局并发已满（跨会话排队，前面 ${q.position} 个）——有会话完成即自动执行`
          : `⏳ 已排队（第 ${q.position} 位）——前一条处理完后自动执行`,
        ts: Date.now(),
      });
      break;
    }
    case 'sub_event': {
      // M18：子代理事件折叠为时间线（轮次分组 + 按序节点）。
      // 文本节点相邻累积；工具节点 pending→result/denied 收拢状态；
      // M15 审批（嵌套 approval_required）是时间线内的一等节点，tool_approved/tool_denied 收拢其状态。
      return next.map(b => {
        if (b.kind !== 'tool' || b.call.id !== ev.callId) return b;
        const inner = ev.ev as LoopEvent;
        const turns = [...(b.subTimeline ?? [])];
        const curIdx = (): number => {
          if (turns.length === 0) turns.push({ turn: 1, nodes: [] });
          return turns.length - 1;
        };
        const setNodes = (idx: number, nodes: SubTimelineTurn['nodes']) => {
          turns[idx] = { ...turns[idx]!, nodes };
        };
        switch (inner.type) {
          case 'turn_start':
            turns.push({ turn: inner.turn, nodes: [] });
            break;
          case 'text_delta': {
            const i = curIdx();
            const nodes = [...turns[i]!.nodes];
            const last = nodes[nodes.length - 1];
            if (last?.kind === 'text') nodes[nodes.length - 1] = { kind: 'text', text: last.text + inner.text };
            else nodes.push({ kind: 'text', text: inner.text });
            setNodes(i, nodes);
            break;
          }
          case 'tool_pending': {
            const i = curIdx();
            const nodes = [...turns[i]!.nodes];
            nodes.push({ kind: 'tool', name: inner.call.name, summary: argSummary(inner.call.name, inner.call.input), status: 'running' });
            setNodes(i, nodes);
            break;
          }
          case 'tool_result':
          case 'tool_denied': {
            // 子循环串行：从后往前找最近的同名 running 节点收拢（跨轮兜底）
            for (let t = turns.length - 1; t >= 0; t--) {
              const nodes = [...turns[t]!.nodes];
              let touched = false;
              for (let n = nodes.length - 1; n >= 0; n--) {
                const nd = nodes[n]!;
                if (nd.kind === 'tool' && nd.name === inner.call.name && nd.status === 'running') {
                  nodes[n] = inner.type === 'tool_result'
                    ? { ...nd, status: inner.isError ? 'error' : 'done', result: inner.result }
                    : { ...nd, status: 'denied' };
                  touched = true;
                  break;
                }
              }
              if (inner.type === 'tool_denied') {
                // 拒绝同时收拢审批节点（子级审批被拒 → sub loop 只 yield tool_denied，没有 tool_approved）
                const ai = nodes.findIndex(x => x.kind === 'approval' && x.fullId === `${ev.callId}:${inner.call.id}`);
                if (ai >= 0) {
                  nodes[ai] = { ...(nodes[ai] as Extract<SubTimelineTurn['nodes'][number], { kind: 'approval' }>), status: 'denied' };
                  touched = true;
                }
              }
              if (touched) { setNodes(t, nodes); break; }
            }
            break;
          }
          case 'tool_approved': {
            // 命名空间 fullId = `${父callId}:${子id}`：收拢审批节点状态
            for (let t = turns.length - 1; t >= 0; t--) {
              const nodes = [...turns[t]!.nodes];
              const n = nodes.findIndex(x => x.kind === 'approval' && x.fullId === `${ev.callId}:${inner.call.id}`);
              if (n >= 0) { nodes[n] = { ...(nodes[n] as Extract<SubTimelineTurn['nodes'][number], { kind: 'approval' }>), status: 'approved' }; setNodes(t, nodes); break; }
            }
            break;
          }
          default:
            if ((inner as { type: string }).type === 'approval_required') {
              const a = inner as unknown as ApprovalRequiredEvent;
              const i = curIdx();
              const nodes = [...turns[i]!.nodes];
              const p = a.call.input?.path;
              nodes.push({
                kind: 'approval', fullId: a.callId, name: a.call.name,
                summary: typeof p === 'string' ? p : JSON.stringify(a.call.input ?? {}).slice(0, 60),
                status: 'waiting',
              });
              setNodes(i, nodes);
            }
            break; // thinking/usage/compacted 等暂不展开
        }
        return { ...b, subTimeline: turns };
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
