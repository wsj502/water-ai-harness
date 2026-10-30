/**
 * 会话持久化：Node 24 内置 node:sqlite（零依赖、无原生模块、Docker 友好）。
 *
 * 存储位置：<工作区>/.water/sessions.db（会话跟着工作区走）
 * 策略：MVP 粗粒度——每次消息处理结束后整存整取该会话的全部消息。
 * 数据量小（单会话几十条），重建比增量同步简单且可靠。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { WMessage } from '@water/core';

interface SessionRow { id: string; title: string; created_at: number; protocol?: string | null; model?: string | null; archived?: number | null }
interface MessageRow { session_id: string; seq: number; role: string; parts: string }
export interface TaskRow {
  id: string; session_id: string; title: string;
  started_at: number; finished_at: number; status: string;
  steps: string; tokens_in: number; tokens_out: number;
}

export class SessionPersistence {
  private db: DatabaseSync;

  constructor(cwd: string) {
    const dir = path.join(cwd, '.water');
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'sessions.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        parts TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        steps TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0
      );
    `);
    // M1 迁移：老库补会话级模型覆盖两列（新库 CREATE 未含；重复执行安全）
    this.addColumnIfMissing('sessions', 'protocol', 'TEXT');
    this.addColumnIfMissing('sessions', 'model', 'TEXT');
    // M7A 迁移：归档标记
    this.addColumnIfMissing('sessions', 'archived', 'INTEGER');
  }

  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!cols.some(c => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  loadAll(): { id: string; title: string; createdAt: number; messages: WMessage[]; protocol?: string | null; model?: string | null; archived?: boolean }[] {
    const sessions = this.db
      .prepare('SELECT id, title, created_at, protocol, model, archived FROM sessions ORDER BY created_at DESC')
      .all() as unknown as SessionRow[];
    const msgStmt = this.db.prepare(
      'SELECT role, parts FROM messages WHERE session_id = ? ORDER BY seq',
    );
    return sessions.map(s => {
      const rows = msgStmt.all(s.id) as unknown as MessageRow[];
      const messages: WMessage[] = rows.map(r => ({
        role: r.role as WMessage['role'],
        parts: JSON.parse(r.parts) as WMessage['parts'],
      }));
      return {
        id: s.id, title: s.title, createdAt: s.created_at, messages,
        protocol: s.protocol ?? null, model: s.model ?? null,
        archived: Boolean(s.archived),
      };
    });
  }

  /** 整存整取：删旧插新（事务保证原子性） */
  saveSession(
    id: string, title: string, createdAt: number, messages: WMessage[],
    config?: { protocol?: string | null; model?: string | null; archived?: boolean },
  ): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        'INSERT INTO sessions (id, title, created_at, protocol, model, archived) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET title = excluded.title, protocol = excluded.protocol, model = excluded.model, archived = excluded.archived',
      ).run(id, title, createdAt, config?.protocol ?? null, config?.model ?? null, config?.archived ? 1 : 0);
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      const ins = this.db.prepare(
        'INSERT INTO messages (session_id, seq, role, parts) VALUES (?, ?, ?, ?)',
      );
      messages.forEach((m, i) => ins.run(id, i, m.role, JSON.stringify(m.parts)));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  saveTask(t: TaskRow): void {
    this.db.prepare(
      'INSERT INTO tasks (id, session_id, title, started_at, finished_at, status, steps, tokens_in, tokens_out) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(t.id, t.session_id, t.title, t.started_at, t.finished_at, t.status, t.steps, t.tokens_in, t.tokens_out);
  }

  loadTasks(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY started_at DESC LIMIT 200').all() as unknown as TaskRow[];
  }

  close(): void { this.db.close(); }
}
