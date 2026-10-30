/**
 * 会话存储（内存版）：P3 先内存，持久化（SQLite）留给后续阶段。
 *
 * 关键设计：审批桥。
 * Agent Loop 里的 approve 回调是同步等待的 Promise；
 * HTTP 世界里审批动作来自另一个 POST 请求。
 * 桥接方式：pending Map 存 resolver，approve 端点命中后 resolve。
 */
import { PermissionEngine, type ToolUsePart, type WMessage } from '@water/core';
import type { TaskRow } from './persistence.js';

export type ApprovalDecision = 'once' | 'session' | 'deny';
export type SessionProtocol = 'anthropic' | 'openai';

/** 任务 = 一次消息处理（Agent Loop 运行）的记录，供任务页展示 */
export interface TaskStep {
  tool: string;
  summary: string;
  ok: boolean | null;   // null = 被拒绝/阻止
  durationMs: number;
}

export interface TaskRecord {
  id: string;
  sessionId: string;
  title: string;
  startedAt: number;
  finishedAt: number;
  /** running：Loop 进行中（仅内存态，落库时必定已是终态） */
  status: 'running' | 'done' | 'error' | 'aborted' | 'max_turns';
  steps: TaskStep[];
  tokensIn: number;
  tokensOut: number;
}

interface PendingApproval {
  call: ToolUsePart;
  resolve: (d: ApprovalDecision) => void;
}

/** 回放缓冲的事件条目（SSE 帧的 id 即 seq） */
export interface BufferedEvent {
  seq: number;
  ev: unknown;
}

export class Session {
  readonly id: string;
  createdAt = Date.now();
  title = '新会话';
  messages: WMessage[] = [];
  permissions = new PermissionEngine({ autoAllowLowRisk: true });
  /** M1：会话级模型覆盖（null = 跟随服务端默认） */
  protocol: SessionProtocol | null = null;
  model: string | null = null;
  /** M7A：归档（从「最近会话」收起；历史可看，不可再发消息） */
  archived = false;
  /** M7B：绑定工作区（null = default；创建时定死，存续期不可换根） */
  workspaceId: string | null = null;
  /** 会话级 token 累计（侧栏「12.4k tok」的真实数据源） */
  tokensIn = 0;
  tokensOut = 0;
  /** 同一时刻只允许一条消息在跑（MVP 约束，避免历史交错） */
  busy = false;
  /** M3：当前运行的事件回放缓冲（每条消息开始时重置；断线补帧/刷新接流用） */
  events: BufferedEvent[] = [];
  private seq = 0;
  private pending = new Map<string, PendingApproval>();

  constructor(id: string) { this.id = id; }

  /** 记录事件进回放缓冲，返回它的 seq（SSE 帧 id） */
  recordEvent(ev: unknown): number {
    this.events.push({ seq: ++this.seq, ev });
    if (this.events.length > 300) this.events.shift();
    return this.seq;
  }

  /** 每条消息运行开始时清空（缓冲只覆盖"当前这一跑"，历史由 messages 端点负责） */
  resetEventBuffer(): void {
    this.events = [];
    this.seq = 0;
  }

  eventsSince(since: number): BufferedEvent[] {
    return this.events.filter(e => e.seq > since);
  }

  /** 给 Agent Loop 用的 approve 回调 */
  waitApproval(call: ToolUsePart): Promise<ApprovalDecision> {
    return new Promise(resolve => {
      this.pending.set(call.id, { call, resolve });
    });
  }

  /** 审批端点调用 */
  resolveApproval(callId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(callId);
    if (!p) return false;
    this.pending.delete(callId);
    p.resolve(decision);
    return true;
  }

  /** 连接中断/会话结束时，所有悬挂审批一律拒绝（保守兜底） */
  denyAllPending(): void {
    for (const [, p] of this.pending) p.resolve('deny');
    this.pending.clear();
  }

  get pendingCount(): number { return this.pending.size; }
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private tasks: TaskRecord[] = [];

  constructor(private persistence?: import('./persistence.js').SessionPersistence) {
    // 启动恢复：从 SQLite 读回历史会话
    for (const r of persistence?.loadAll() ?? []) {
      const s = new Session(r.id);
      s.title = r.title;
      s.createdAt = r.createdAt;
      s.messages = r.messages;
      s.protocol = r.protocol === 'anthropic' || r.protocol === 'openai' ? r.protocol : null;
      s.model = r.model ?? null;
      s.archived = Boolean(r.archived);
      s.workspaceId = r.workspaceId ?? null;
      this.sessions.set(r.id, s);
    }
    // 恢复任务记录（running 态只存在于内存；若落库盘里出现，说明上次进程被杀 → 记为中断）
    for (const t of persistence?.loadTasks() ?? []) {
      const status = t.status === 'running' ? 'aborted' : t.status;
      this.tasks.push({
        id: t.id, sessionId: t.session_id, title: t.title,
        startedAt: t.started_at, finishedAt: t.finished_at,
        status: status as TaskRecord['status'],
        steps: JSON.parse(t.steps) as TaskStep[],
        tokensIn: t.tokens_in, tokensOut: t.tokens_out,
      });
    }
  }

  /** Loop 开始即建档：任务页可见「运行中」（仅内存，不落库） */
  beginTask(t: TaskRecord): void {
    this.tasks.unshift(t);
  }

  /** Loop 结束：任务已有终态，落库 */
  finishTask(t: TaskRecord): void {
    try {
      this.persistence?.saveTask({
        id: t.id, session_id: t.sessionId, title: t.title,
        started_at: t.startedAt, finished_at: t.finishedAt,
        status: t.status, steps: JSON.stringify(t.steps),
        tokens_in: t.tokensIn, tokens_out: t.tokensOut,
      });
    } catch (e) {
      console.error('[persistence] 任务落库失败:', e instanceof Error ? e.message : e);
    }
  }

  listTasks(): TaskRecord[] { return this.tasks.slice(0, 200); }

  create(init?: { protocol?: SessionProtocol | null; model?: string | null }): Session {
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const s = new Session(id);
    if (init) {
      s.protocol = init.protocol ?? null;
      s.model = init.model ?? null;
    }
    this.sessions.set(id, s);
    this.save(s);
    return s;
  }

  /** 落库（每次消息处理完调用；事务整存整取） */
  save(s: Session): void {
    try {
      this.persistence?.saveSession(s.id, s.title, s.createdAt, s.messages, {
        protocol: s.protocol, model: s.model, archived: s.archived,
        workspaceId: s.workspaceId,
      });
    } catch (e) {
      console.error(`[persistence] 会话 ${s.id} 落库失败:`, e instanceof Error ? e.message : e);
    }
  }

  delete(id: string): boolean {
    const existed = this.sessions.delete(id);
    if (existed) this.persistence?.deleteSession(id);
    return existed;
  }

  get(id: string): Session | undefined { return this.sessions.get(id); }

  list(archived = false) {
    return [...this.sessions.values()]
      .filter(s => s.archived === archived)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(s => ({
        id: s.id, title: s.title, createdAt: s.createdAt,
        turns: s.messages.filter(m => m.role === 'user').length,
        tokensIn: s.tokensIn, tokensOut: s.tokensOut,
        busy: s.busy, pendingApprovals: s.pendingCount,
        protocol: s.protocol, model: s.model, archived: s.archived,
        workspaceId: s.workspaceId,
      }));
  }
}
