/**
 * M1 离线 E2E：模型注册表 + 会话级切换的全链路验证（mock 模式，零凭据）。
 *
 * 前置：npm run build（脚本直接拉起 apps/server/dist 的构建产物，避免 npx/shell 差异）
 * 运行：npx tsx scripts/e2e-model-switch.ts
 *
 * 验证点（对应 issue #3 验收）：
 *   1. /api/models 返回内置双协议模型 + default + mock 标记
 *   2. 建会话可携带初始模型；模型自带协议推断（openai 协议模型）
 *   3. 发消息 → SSE 首帧 turn_start.model 与会话模型一致
 *   4. PATCH 运行时切换模型 → 下一条消息即用新模型（无需重启进程）
 *   5. reset 回到服务端默认；两个会话模型互不干扰
 *   6. 非法模型被 400 拒绝
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'apps', 'server', 'dist', 'index.js');
const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
function ok(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) as T };
}

/** 读一条 SSE 流直到 finish，返回全部事件（帧解析与 web 端同构） */
async function readSSE(url: string, init: RequestInit): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(url, init);
  if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try {
        const ev = JSON.parse(data) as Record<string, unknown>;
        events.push(ev);
        if (ev.type === 'finish') return events;
      } catch { /* 跳过坏帧 */ }
    }
  }
  return events;
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server 15s 内未就绪');
}

async function main(): Promise<void> {
  if (!existsSync(SERVER)) {
    throw new Error(`未找到 ${SERVER}——请先 npm run build`);
  }
  // 独立临时工作区：测试会话/数据库不污染开发目录
  const workdir = mkdtempSync(path.join(tmpdir(), 'water-e2e-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, WATER_MOCK: '1', WATER_PORT: String(PORT) },
    cwd: workdir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', () => { /* 吞掉启动日志 */ });
  child.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  try {
    await waitReady();
    console.log('=== M1 模型注册表 + 会话级切换 · 离线 E2E ===\n');

    // ---- 1. /api/models ----
    const models = await jfetch<{ models: Array<{ id: string; protocol: string; hasKey: boolean }>; default: { model: string }; mock: boolean }>(`${BASE}/api/models`);
    ok(models.status === 200, '/api/models 200');
    ok(models.body.mock === true, '/api/models 标记 mock');
    ok(models.body.models.some(m => m.id === 'glm-4.6' && m.protocol === 'anthropic'), '内置 glm-4.6（anthropic）');
    ok(models.body.models.some(m => m.id === 'deepseek-chat' && m.protocol === 'openai'), '内置 deepseek-chat（openai）');
    ok(models.body.models.every(m => m.hasKey === true), 'mock 模式下凭据标记全部就绪');

    // ---- 2. 建会话带初始模型（openai 协议模型 → 协议随模型）----
    const s1 = await jfetch<{ id: string; protocol: string | null; model: string | null }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat' }),
    });
    ok(s1.status === 201 && s1.body.model === 'deepseek-chat', '建会话携带初始模型 deepseek-chat');
    ok(s1.body.protocol === 'openai', '协议随模型推断为 openai（免错配）');

    // ---- 3. 首条消息：turn_start 携带会话模型 ----
    const post = (sid: string) => ({
      method: 'POST' as const,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '看看有什么文件' }),
    });
    const ev1 = await readSSE(`${BASE}/api/sessions/${s1.body.id}/messages`, post(s1.body.id));
    const ts1 = ev1.find(e => e.type === 'turn_start') as { model?: string } | undefined;
    ok(ts1?.model === 'deepseek-chat', 'SSE turn_start.model = deepseek-chat');
    ok(ev1.at(-1)?.type === 'finish', 'SSE 正常 finish');

    // ---- 4. 运行时切换模型：不重启进程，下一条消息即生效 ----
    const patched = await jfetch<{ ok: boolean; model: string | null; protocol: string | null }>(`${BASE}/api/sessions/${s1.body.id}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'glm-4.6' }),
    });
    ok(patched.status === 200 && patched.body.model === 'glm-4.6', 'PATCH 切换到 glm-4.6');
    ok(patched.body.protocol === 'anthropic', '协议随模型切为 anthropic');
    const ev2 = await readSSE(`${BASE}/api/sessions/${s1.body.id}/messages`, post(s1.body.id));
    const ts2 = ev2.find(e => e.type === 'turn_start') as { model?: string } | undefined;
    ok(ts2?.model === 'glm-4.6', '切换后 turn_start.model = glm-4.6（运行时生效）');

    // ---- 5. reset + 双会话隔离 ----
    const s2 = await jfetch<{ id: string; model: null }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    ok(s2.body.model === null, '默认会话 model=null（跟随服务端）');
    const rst = await jfetch<{ model: null }>(`${BASE}/api/sessions/${s1.body.id}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true }),
    });
    ok(rst.status === 200 && rst.body.model === null, 'reset 清除会话覆盖');
    const list = await jfetch<{ sessions: Array<{ id: string; model: string | null }> }>(`${BASE}/api/sessions`);
    const m1 = list.body.sessions.find(s => s.id === s1.body.id)?.model;
    const m2 = list.body.sessions.find(s => s.id === s2.body.id)?.model;
    ok(m1 === null && m2 === null, '会话列表回显覆盖状态');

    // ---- 6. 非法模型 400 + 越权字段（baseUrl）显式 400 ----
    const bad = await jfetch<{ error?: string }>(`${BASE}/api/sessions/${s2.body.id}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-99-nonexistent' }),
    });
    ok(bad.status === 400, '未知模型被 400 拒绝');
    const evil = await jfetch<{ error?: string }>(`${BASE}/api/sessions/${s2.body.id}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'glm-4.6', baseUrl: 'https://evil.com' }),
    });
    ok(evil.status === 400 && /baseUrl|字段/.test(evil.body.error ?? ''), '越权 baseUrl 字段被 400 显式拒绝（防 key 外泄）');

    console.log(`\n${failed === 0 ? '✅ E2E PASS' : `❌ E2E FAIL（${failed} 项）`}`);
  } finally {
    // 等子进程真正退出再清临时目录（Windows 下进程 cwd 会锁目录，立刻删必 EPERM）
    child.kill();
    await Promise.race([
      new Promise<void>(res => child.once('exit', res)),
      new Promise<void>(res => setTimeout(res, 3000)),
    ]);
    try { rmSync(workdir, { recursive: true, force: true }); }
    catch { /* 清理失败不影响结果：留在 %TEMP% 由系统回收 */ }
  }
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('E2E 异常:', e); process.exit(1); });
