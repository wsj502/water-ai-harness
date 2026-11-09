/**
 * #96 会话持久化往返：token 累计随会话落库/恢复（此前只存内存，重启归零）。
 * 直接测 SessionPersistence + SessionStore 组合（临时目录真 SQLite，不 mock）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../apps/server/src/session.js';
import { SessionPersistence } from '../apps/server/src/persistence.js';

const dirs: string[] = [];
function workdir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'water-persist-'));
  dirs.push(d);
  return d;
}
// Windows：DatabaseSync 句柄在进程内不关（persistence 未暴露 close），
// 目录删除可能 EPERM——清理是尽力而为，失败不判测试失败（断言只关心往返语义）
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { /* 句柄未释放，留给系统临时目录清理 */ }
  }
  dirs.length = 0;
});

describe('会话持久化（#96：token 累计入库）', () => {
  it('token 累计入持久层，重启（重建 store）后不归零', () => {
    const wd = workdir();
    const store = new SessionStore(new SessionPersistence(wd));
    const s = store.create({ model: 'glm-4.6' });
    s.tokensIn = 12345;
    s.tokensOut = 678;
    store.save(s);

    // 模拟重启：同一 DB 上重建 store（进程内存态全部丢失）
    const store2 = new SessionStore(new SessionPersistence(wd));
    const restored = store2.get(s.id)!;
    expect(restored.tokensIn).toBe(12345);
    expect(restored.tokensOut).toBe(678);
    // 侧栏数据源（list 端点读的就是这两个字段）
    expect(store2.list().find(x => x.id === s.id)?.tokensIn).toBe(12345);
    // 其余恢复项不回归
    expect(restored.model).toBe('glm-4.6');
    expect(restored.messages).toEqual([]);
  });

  it('老库（sessions 无 tokens 列）自动迁移：默认 0，迁移后写入可读回', () => {
    const wd = workdir();
    // 手工造 #96 之前形态的老库：sessions 只有基础三列
    const dbDir = path.join(wd, '.water');
    mkdirSync(dbDir, { recursive: true });
    const legacy = new DatabaseSync(path.join(dbDir, 'sessions.db'));
    legacy.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)').run('s_legacy', '老会话', 1000);
    legacy.close();

    // 打开即迁移（addColumnIfMissing 补列），老会话 token 默认 0
    const store = new SessionStore(new SessionPersistence(wd));
    const restored = store.get('s_legacy')!;
    expect(restored.tokensIn).toBe(0);

    // 迁移后的库可正常写入/读回
    restored.tokensIn = 42;
    store.save(restored);
    const store2 = new SessionStore(new SessionPersistence(wd));
    expect(store2.get('s_legacy')!.tokensIn).toBe(42);
  });
});

describe('会话持久化（#114：终局 post-mortem 入库）', () => {
  it('lastFinish 落库，重启（重建 store）后恢复；list 端点透出', () => {
    const wd = workdir();
    const store = new SessionStore(new SessionPersistence(wd));
    const s = store.create({});
    s.lastFinish = { reason: 'error', message: 'Anthropic 401: 令牌已过期', at: 1731000000000 };
    store.save(s);

    const store2 = new SessionStore(new SessionPersistence(wd));
    const restored = store2.get(s.id)!;
    expect(restored.lastFinish).toEqual({ reason: 'error', message: 'Anthropic 401: 令牌已过期', at: 1731000000000 });
    expect(store2.list().find(x => x.id === s.id)?.lastFinish?.reason).toBe('error');
  });

  it('老库（无 last_finish 列）自动迁移：默认 null；正常结束（end）不渲染通知由前端负责', () => {
    const wd = workdir();
    const dbDir = path.join(wd, '.water');
    mkdirSync(dbDir, { recursive: true });
    const legacy = new DatabaseSync(path.join(dbDir, 'sessions.db'));
    legacy.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)').run('s_legacy', '老会话', 1000);
    legacy.close();

    const store = new SessionStore(new SessionPersistence(wd));
    expect(store.get('s_legacy')!.lastFinish).toBeNull();

    store.get('s_legacy')!.lastFinish = { reason: 'aborted', at: 1 };
    store.save(store.get('s_legacy')!);
    const store2 = new SessionStore(new SessionPersistence(wd));
    expect(store2.get('s_legacy')!.lastFinish).toEqual({ reason: 'aborted', at: 1 });
  });
});
