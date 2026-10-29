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

interface SessionRow { id: string; title: string; created_at: number }
interface MessageRow { session_id: string; seq: number; role: string; parts: string }

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
    `);
  }

  loadAll(): { id: string; title: string; createdAt: number; messages: WMessage[] }[] {
    const sessions = this.db
      .prepare('SELECT id, title, created_at FROM sessions ORDER BY created_at DESC')
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
      return { id: s.id, title: s.title, createdAt: s.created_at, messages };
    });
  }

  /** 整存整取：删旧插新（事务保证原子性） */
  saveSession(id: string, title: string, createdAt: number, messages: WMessage[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        'INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET title = excluded.title',
      ).run(id, title, createdAt);
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
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  close(): void { this.db.close(); }
}
