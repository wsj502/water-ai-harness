/**
 * SEA sidecar 冒烟（#88 入库；M24 时代的 11 断言曾是 ad-hoc 一次性验证，本脚本使其可复现）。
 *
 * 对象：apps/server/dist-sea/water-server.exe —— Node SEA 单文件（桌面端 tauri 打包内嵌的正是它），
 * 验证「打包形态的 server」而非 dist/index.js：blob 注入失败 / fuse 哨兵不符 / 依赖漂移都会在这里现形。
 *
 * 前置：npm run build && powershell -ExecutionPolicy Bypass -File scripts/build-sea.ps1
 * 运行：npx tsx scripts/sea-smoke.ts
 *
 * 断言面（13 条，覆盖 M24 的 11 条并扩展 v0.8/v0.10 新能力）：
 *   探活 / 版本与仓库一致 / mock 形态 / BYOK 三链路（查-录-删） / 会话创建 /
 *   SSE 剧本到 finish / 帧 id 单调 / 回放等量 / M29 live 补帧等量且补完即关 / 会话列表可见
 *
 * 端口用 3291：避开本机常驻部署（容器 @3210）与 e2e（3217/3218）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXE = path.join(ROOT, 'apps', 'server', 'dist-sea', 'water-server.exe');
const PORT = 3291;
const BASE = `http://127.0.0.1:${PORT}`;
// 版本断言以仓库 package.json 为准（而不是硬编码），bump 之后本脚本无需跟着改
const EXPECT_VER = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;

let failed = 0;
function ok(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) as T };
}

/** 读 SSE 直到 finish（与 web 端/e2e 同构的帧解析；ids 收集帧 id 用于单调性断言） */
async function readSSE(url: string, init: RequestInit, ids?: string[]): Promise<Array<Record<string, unknown>>> {
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
      const idLine = frame.split('\n').find(l => l.startsWith('id:'));
      if (idLine && ids) ids.push(idLine.slice(3).trim());
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
    try { if ((await fetch(`${BASE}/api/config`)).ok) return; } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('SEA server 15s 内未就绪');
}

async function main(): Promise<void> {
  if (!existsSync(EXE)) {
    throw new Error(`未找到 ${EXE}——先 npm run build && powershell -ExecutionPolicy Bypass -File scripts/build-sea.ps1`);
  }
  // 独立临时目录做 cwd：会话库/持久化落在这里，不污染仓库也不碰本机 ~/.water
  const workdir = mkdtempSync(path.join(tmpdir(), 'water-sea-smoke-'));
  const child = spawn(EXE, [], {
    env: { ...process.env, WATER_MOCK: '1', WATER_PORT: String(PORT) },
    cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stderr.on('data', () => { /* SEA 启动噪声不进断言视野 */ });
  try {
    await waitReady();
    console.log(`SEA 冒烟（${path.basename(EXE)}，期望版本 ${EXPECT_VER}）`);

    // ---- 1. 探活 / 版本 / mock 形态 ----
    const cfg = await jfetch<{ version: string; protocol: string }>(`${BASE}/api/config`);
    ok(cfg.status === 200, '探活 /api/config 200');
    ok(cfg.body.version === EXPECT_VER, `/api/config.version = ${EXPECT_VER}（SEA 内嵌当前构建）`, `实际 ${cfg.body.version}`);
    const models = await jfetch<{ mock: boolean }>(`${BASE}/api/models`);
    ok(models.body.mock === true, '/api/models 标记 mock（M24 教训：mock 布尔在这里，不在 /api/config）');

    // ---- 2. v0.8 BYOK 三链路：查 → 录（尾4位回显）→ 删 ----
    const keysGet = await jfetch<{ keys: unknown[] }>(`${BASE}/api/keys`);
    ok(keysGet.status === 200 && Array.isArray(keysGet.body.keys), 'GET /api/keys 200（v0.8 BYOK 端点存在于打包形态）');
    const DEMO = 'sea-smoke-demo-key-1234'; // 演示值，非真实凭据
    const keysPost = await jfetch<{ ok: boolean; hint: string }>(`${BASE}/api/keys`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKeyEnv: 'WATER_SEA_SMOKE', value: DEMO }),
    });
    ok(keysPost.status === 200 && keysPost.body.hint === `…${DEMO.slice(-4)}`, 'POST /api/keys 录入回显尾4位（值不落盘）');
    const keysDel = await jfetch<{ ok: boolean }>(`${BASE}/api/keys/WATER_SEA_SMOKE`, { method: 'DELETE' });
    ok(keysDel.status === 200, 'DELETE /api/keys/:name 清除录入');

    // ---- 3. 会话 + SSE 剧本 + 帧序 ----
    const s = await jfetch<{ id: string }>(`${BASE}/api/sessions`, { method: 'POST' });
    ok(s.status === 201 && !!s.body.id, '会话创建 201');
    const ids: string[] = [];
    const ev = await readSSE(`${BASE}/api/sessions/${s.body.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '看看有什么文件' }),
    }, ids);
    ok(ev.some(e => e.type === 'turn_start') && ev.at(-1)?.type === 'finish', 'SSE 剧本 turn_start → finish 走完');
    ok(ids.every((v, i) => i === 0 || Number(v) > Number(ids[i - 1])), `帧 id 单调递增（共 ${ids.length} 帧）`);

    // ---- 4. 回放等量 / M29 live 补帧等量且补完即关 ----
    const replay = await jfetch<{ events: unknown[]; busy: boolean }>(`${BASE}/api/sessions/${s.body.id}/events?since=0`);
    ok(replay.body.events.length === ev.length && replay.body.busy === false, `回放缓冲与 SSE 帧逐帧等量（${replay.body.events.length}）`);
    const live = await readSSE(`${BASE}/api/sessions/${s.body.id}/stream?since=0`, { method: 'GET' });
    ok(live.length === ev.length && live.at(-1)?.type === 'finish', `M29 live 非 busy 补完即关（${live.length} 帧含 finish）`);

    // ---- 5. 会话列表可见（注册表/持久化链路活着） ----
    const list = await jfetch<{ sessions: Array<{ id: string }> }>(`${BASE}/api/sessions`);
    ok(list.body.sessions.some(x => x.id === s.body.id), '会话列表包含新建会话');

    // ---- 6. 收尾：进程能被干净终止（桌面端窗口关闭即走这条链路） ----
    const exited = new Promise<boolean>(r => child.once('exit', () => r(true)));
    child.kill();
    ok(await Promise.race([exited, new Promise<false>(r => setTimeout(() => r(false), 5000))]), 'sidecar 进程可干净终止');
  } finally {
    if (!child.killed) child.kill();
    rmSync(workdir, { recursive: true, force: true });
  }
  console.log(failed === 0 ? '\nSEA 冒烟全绿 ✅' : `\n${failed} 条断言失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
