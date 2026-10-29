/**
 * 会话存储（内存版）：P3 先内存，持久化（SQLite）留给后续阶段。
 *
 * 关键设计：审批桥。
 * Agent Loop 里的 approve 回调是同步等待的 Promise；
 * HTTP 世界里审批动作来自另一个 POST 请求。
 * 桥接方式：pending Map 存 resolver，approve 端点命中后 resolve。
 */
import { PermissionEngine, type ToolUsePart, type WMessage } from '@water/core';

export type ApprovalDecision = 'once' | 'session' | 'deny';

interface PendingApproval {
  call: ToolUsePart;
  resolve: (d: ApprovalDecision) => void;
}

export class Session {
  readonly id: string;
  createdAt = Date.now();
  title = '新会话';
  messages: WMessage[] = [];
  permissions = new PermissionEngine({ autoAllowLowRisk: true });
  /** 同一时刻只允许一条消息在跑（MVP 约束，避免历史交错） */
  busy = false;
  private pending = new Map<string, PendingApproval>();

  constructor(id: string) { this.id = id; }

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

  constructor(private persistence?: import('./persistence.js').SessionPersistence) {
    // 启动恢复：从 SQLite 读回历史会话
    for (const r of persistence?.loadAll() ?? []) {
      const s = new Session(r.id);
      s.title = r.title;
      s.createdAt = r.createdAt;
      s.messages = r.messages;
      this.sessions.set(r.id, s);
    }
  }

  create(): Session {
    const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const s = new Session(id);
    this.sessions.set(id, s);
    this.save(s);
    return s;
  }

  /** 落库（每次消息处理完调用；事务整存整取） */
  save(s: Session): void {
    try {
      this.persistence?.saveSession(s.id, s.title, s.createdAt, s.messages);
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

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(s => ({
        id: s.id, title: s.title, createdAt: s.createdAt,
        turns: s.messages.filter(m => m.role === 'user').length,
        busy: s.busy, pendingApprovals: s.pendingCount,
      }));
  }
}
