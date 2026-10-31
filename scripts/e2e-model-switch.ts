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
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

/** 读一条 SSE 流直到 finish，返回全部事件（帧解析与 web 端同构；ids 收集帧 id） */
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
  // 独立临时工作区：测试会话/数据库不污染开发目录；第二个目录用于 M7B 多工作区验证
  const workdir = mkdtempSync(path.join(tmpdir(), 'water-e2e-'));
  const workdir2 = mkdtempSync(path.join(tmpdir(), 'water-e2e2-'));
  // M22：本地 mock HTTP server（echo 接口）——http 型配置工具的出网目标
  const seenHttp: Array<{ q: string | null; auth: string | null }> = [];
  const mockHttp = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    seenHttp.push({ q: u.searchParams.get('q'), auth: req.headers.authorization ?? null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ echo: u.searchParams.get('q'), ok: true }));
  });
  await new Promise<void>(r => mockHttp.listen(0, '127.0.0.1', () => r()));
  const mockHttpPort = (mockHttp.address() as { port: number }).port;
  // M13：配置式命令——测试注入的临时 config.json（含展开验证用模板）
  // M17：配置式声明工具（prompt 型）——seal 工具，E2E 第 14 节实证「声明→注册→调用→模板回填」
  // M22：http 型配置工具——ping-api，出网到上方 mock server（白名单 127.0.0.1 + $env: 凭据插值）
  const cfgFile = path.join(workdir, 'test-config.json');
  writeFileSync(cfgFile, JSON.stringify({
    commands: [{ name: 'say', template: '请原样输出以下内容：[$ARGUMENTS]', description: '回显命令' }],
    allowedHttpHosts: ['127.0.0.1'],
    tools: [{
      name: 'seal',
      description: '给文本盖章（M17 演示）',
      template: '已盖章：$text',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要盖章的文本' } },
        required: ['text'],
      },
    }, {
      name: 'ping-api',
      kind: 'http',
      description: '查询演示接口（M22）',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '查询词' } },
        required: ['text'],
      },
      http: {
        url: `http://127.0.0.1:${mockHttpPort}/echo?q=$text`,
        headers: { Authorization: 'Bearer $env:WATER_M22_E2E_KEY' },
      },
    }],
  }), 'utf8');
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, WATER_MOCK: '1', WATER_PORT: String(PORT),
      WATER_WORKSPACES: workdir2, WATER_CONFIG_FILE: cfgFile,
      WATER_MAX_PARALLEL_SESSIONS: '2',
      WATER_M22_E2E_KEY: 'e2e-demo-token', // 演示用假 token（$env: 插值链路的验证载体，非真实凭据）
    },
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
    const frameIds: string[] = [];
    const ev1 = await readSSE(`${BASE}/api/sessions/${s1.body.id}/messages`, post(s1.body.id), frameIds);
    const ts1 = ev1.find(e => e.type === 'turn_start') as { model?: string } | undefined;
    ok(ts1?.model === 'deepseek-chat', 'SSE turn_start.model = deepseek-chat');
    ok(ev1.at(-1)?.type === 'finish', 'SSE 正常 finish');
    ok(frameIds.length > 0 && frameIds[0] === '1', `SSE 帧带递增 id（首帧 id=${frameIds[0]}）`);

    // ---- 3.5 事件回放（M3）：断线补帧端点 ----
    const replay = await jfetch<{ events: Array<{ seq: number; ev: { type: string } }>; busy: boolean }>(`${BASE}/api/sessions/${s1.body.id}/events?since=0`);
    ok(replay.status === 200 && replay.body.events.length === ev1.length, `events?since=0 回放完整（${replay.body.events.length} 条）`);
    ok(replay.body.events[0]?.ev.type === 'turn_start', '回放首条是 turn_start');
    ok(replay.body.events.every((e, k) => e.seq === k + 1), 'seq 从 1 连续递增');
    const replay2 = await jfetch<{ events: unknown[] }>(`${BASE}/api/sessions/${s1.body.id}/events?since=${replay.body.events.length}`);
    ok(replay2.body.events.length === 0, 'since=末尾 返回空（增量游标语义）');

    // ---- 3.6 工具清单含 M8 子代理（task，medium 风险）----
    const perms = await jfetch<{ rules: Array<{ tool: string; risk: string }> }>(`${BASE}/api/permissions`);
    const taskRule = perms.body.rules.find(r => r.tool === 'task');
    ok(taskRule?.risk === 'medium', 'task 子代理工具在清单中（medium：token 成本需审批）');

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

    // ---- 7. 内置斜杠命令（M2：本地处理不进模型）----
    const s3 = await jfetch<{ id: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const cmd = async (text: string): Promise<string> => {
      const evs = await readSSE(`${BASE}/api/sessions/${s3.body.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      });
      return evs.filter(e => e.type === 'text_delta').map(e => (e as { text?: string }).text ?? '').join('');
    };
    const out1 = await cmd('/model');
    ok(out1.includes('glm-4.6') && out1.includes('可用模型'), '/model 列出模型清单');
    const out2 = await cmd('/model deepseek-chat');
    ok(out2.includes('已切换') && out2.includes('deepseek-chat'), '/model <id> 切换本会话模型');
    const out3 = await cmd('/system');
    ok(out3.includes('Water'), '/system 展示生效 SYSTEM');
    const out4 = await cmd('/compact');
    ok(out4.includes('压缩') || out4.includes('token'), '/compact 报告上下文状态');

    // ---- 8. 会话管理（M7A：归档语义 + 删除接线）----
    const s4 = await jfetch<{ id: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const sid4 = s4.body.id;
    const arch = await jfetch<{ ok: boolean }>(`${BASE}/api/sessions/${sid4}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }),
    });
    ok(arch.status === 200, 'PATCH archived=true 归档');
    const activeList = await jfetch<{ sessions: Array<{ id: string }> }>(`${BASE}/api/sessions`);
    ok(!activeList.body.sessions.some(s => s.id === sid4), '归档后默认列表不可见');
    const archList = await jfetch<{ sessions: Array<{ id: string; archived: boolean }> }>(`${BASE}/api/sessions?archived=1`);
    ok(archList.body.sessions.some(s => s.id === sid4 && s.archived), '?archived=1 可见且标记正确');
    const blocked = await jfetch<{ error?: string }>(`${BASE}/api/sessions/${sid4}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    });
    ok(blocked.status === 400, '归档会话发消息被 400 拒绝');
    const hist = await jfetch<{ title: string }>(`${BASE}/api/sessions/${sid4}/messages`);
    ok(hist.status === 200, '归档会话历史仍可查看');
    const unarch = await jfetch<{ ok: boolean }>(`${BASE}/api/sessions/${sid4}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: false }),
    });
    ok(unarch.status === 200, '取消归档');
    const del = await jfetch<{ ok: boolean }>(`${BASE}/api/sessions/${sid4}`, { method: 'DELETE' });
    ok(del.status === 200 && del.body.ok, 'DELETE 删除会话');
    const gone = await jfetch<{ error?: string }>(`${BASE}/api/sessions/${sid4}/messages`);
    ok(gone.status === 404, '删除后 404');

    // ---- 9. 工作区注册表（M7B：多根绑定 + 白名单防目录逃逸）----
    const wss = await jfetch<{ workspaces: Array<{ id: string; path: string; default: boolean }> }>(`${BASE}/api/workspaces`);
    // 注册表 id 归一化为小写（Windows 路径大小写不敏感），测试侧同步归一
    const ws2id = path.basename(workdir2).toLowerCase();
    ok(wss.body.workspaces.some(w => w.id === 'default' && w.default), '注册表含不可删的 default');
    ok(wss.body.workspaces.some(w => w.id === ws2id && w.path === workdir2), `环境变量工作区 ${ws2id} 注册`);
    const sws = await jfetch<{ id: string; workspaceId: string | null }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: ws2id }),
    });
    ok(sws.status === 201 && sws.body.workspaceId === ws2id, `会话绑定工作区 ${ws2id}`);
    const tree2 = await jfetch<{ root: string }>(`${BASE}/api/files/tree?workspaceId=${encodeURIComponent(ws2id)}`);
    ok(tree2.body.root === workdir2, '文件树按会话工作区解析（root = 第二工作区）');
    const evilWs = await jfetch<{ error?: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: '../../etc' }),
    });
    ok(evilWs.status === 400, '任意路径 workspaceId 被白名单 400 拒绝');
    const patchWs = await jfetch<{ error?: string }>(`${BASE}/api/sessions/${sws.body.id}/config`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: 'default' }),
    });
    ok(patchWs.status === 400, '存续期换根被拒（工作区创建时定死）');

    // ---- 10. 配置式命令（M13：清单可见 + $ARGUMENTS 展开实证）----
    const pluginsResp = await jfetch<{ configCommands: Array<{ name: string }> }>(`${BASE}/api/plugins`);
    ok(pluginsResp.body.configCommands?.some(c => c.name === '/say'), '/api/plugins 列出配置式命令 /say');
    const s5 = await jfetch<{ id: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const evSay = await readSSE(`${BASE}/api/sessions/${s5.body.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '/say 你好世界' }),
    });
    ok(evSay.at(-1)?.type === 'finish', '配置式命令消息正常完成');
    const histSay = await jfetch<{ messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }> }>(`${BASE}/api/sessions/${s5.body.id}/messages`);
    const firstUser = histSay.body.messages.find(m => m.role === 'user');
    const firstText = firstUser?.parts.find(p => p.type === 'text')?.text ?? '';
    ok(firstText.includes('[$ARGUMENTS]') === false && firstText.includes('[你好世界]'), '$ARGUMENTS 已展开为用户参数（历史可证）');

    // ---- 11. 消息排队（M14：并发按序 / queued 事件 / 深度上限）----
    const sq = await jfetch<{ id: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const postMsg = (text: string) => ({
      method: 'POST' as const,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    // 两条并发：第一条先发并确认已获得执行权（busy），第二条必然排队（position=1）
    // ——不依赖跨连接的到达顺序（两条 fetch 可能走不同 socket，服务端到达序无保证，曾 flaky）
    const q1 = readSSE(`${BASE}/api/sessions/${sq.body.id}/messages`, postMsg('第一条消息'));
    for (let i = 0; i < 50; i++) {
      const list = await jfetch<{ sessions: Array<{ id: string; busy: boolean }> }>(`${BASE}/api/sessions`);
      if (list.body.sessions.some(s => s.id === sq.body.id && s.busy)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const q2 = readSSE(`${BASE}/api/sessions/${sq.body.id}/messages`, postMsg('第二条消息'));
    const [r1, r2] = await Promise.all([q1, q2]);
    ok(r1.at(-1)?.type === 'finish' && r2.at(-1)?.type === 'finish', '并发两条均正常完成');
    // 历史顺序 = 到达顺序（闸门串行保证）
    const hq = await jfetch<{ messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }> }>(`${BASE}/api/sessions/${sq.body.id}/messages`);
    const userTexts = hq.body.messages.filter(m => m.role === 'user').map(m => m.parts.find(p => p.type === 'text')?.text ?? '');
    ok(userTexts.indexOf('第一条消息') < userTexts.indexOf('第二条消息'), '消息按到达顺序串行入史');
    // 第六条并发（已 1 执行 + 4 排队占满）→ 429
    const burst = Array.from({ length: 6 }, (_, i) =>
      fetch(`${BASE}/api/sessions/${sq.body.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `burst-${i}` }),
      }));
    const burstResps = await Promise.all(burst);
    const tooMany = burstResps.filter(r => r.status === 429);
    ok(tooMany.length >= 1, `深度上限生效（${tooMany.length} 条被 429）`);
    // 清理：等 burst 中成功入队的跑完，避免影响后续
    await new Promise(r => setTimeout(r, 800));

    // ---- 12. 子代理审批透传（M15：子级 write 审批直达审批桥，callId 命名空间嵌套）----
    const newSession = () => jfetch<{ id: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    }).then(r => r.body.id);
    /** 流式消费 + 审批即时应答（主循环审批恒 once；子级审批按参数决定）——服务端正挂起等这声 POST */
    const streamWithApprovals = async (sid: string, text: string, subDecision: 'once' | 'deny') => {
      const events: Array<Record<string, unknown>> = [];
      const resp = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(data); } catch { continue; }
          events.push(ev);
          const answer = async (callId: unknown, decision: string, label: string) => {
            const r = await jfetch<{ ok: boolean }>(`${BASE}/api/sessions/${sid}/approve`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ callId, decision }),
            });
            ok(r.status === 200 && r.body.ok, `${label}（callId=${String(callId)}）`);
          };
          if (ev.type === 'approval_required') {
            await answer(ev.callId, 'once', 'M15 主循环 task 审批端点应答');
          } else if (ev.type === 'sub_event' && (ev.ev as Record<string, unknown>).type === 'approval_required') {
            await answer((ev.ev as Record<string, unknown>).callId, subDecision, `M15 子级审批端点应答（${subDecision}）`);
          }
          if (ev.type === 'finish') return events;
        }
      }
      return events;
    };
    // 批准路径：父级批准 task + 子级批准 write → 真实落盘
    const sidA = await newSession();
    const evA = await streamWithApprovals(sidA, '[[mock:m15-task]] 让子代理写文件（这次批准）', 'once');
    ok(existsSync(path.join(workdir, 'm15-note.txt')), 'M15 批准路径：子代理真实落盘 m15-note.txt');
    const subApprovalA = evA.find(e => e.type === 'sub_event' && (e.ev as Record<string, unknown>).type === 'approval_required');
    ok(Boolean(subApprovalA), 'M15 子级审批以 sub_event 嵌套帧广播');
    ok(Boolean(subApprovalA && String((subApprovalA.ev as Record<string, unknown>).callId).startsWith('mock-task-m15:')),
      'M15 子级审批 callId 带父级命名空间前缀');
    ok(evA.some(e => e.type === 'sub_event' && (e.ev as Record<string, unknown>).type === 'tool_approved'),
      'M15 子级 write 获批（tool_approved 透传）');
    const taskResA = evA.find(e => e.type === 'tool_result' && (e.call as Record<string, unknown> | undefined)?.name === 'task');
    ok(Boolean(taskResA) && taskResA!.isError === false, 'M15 批准路径 task 正常完成');
    ok(evA.at(-1)?.type === 'finish', 'M15 批准路径正常 finish');
    // 子级审批帧进回放缓冲：刷新接流（events?since=0）可重现审批卡
    const replay15 = await jfetch<{ events: Array<{ seq: number; ev: Record<string, unknown> }> }>(`${BASE}/api/sessions/${sidA}/events?since=0`);
    ok(replay15.body.events.some(e => e.ev.type === 'sub_event'
      && (e.ev.ev as Record<string, unknown>).type === 'approval_required'),
      'M15 子级审批帧进回放缓冲（刷新接流可重现）');
    // 拒绝路径：子级 write 被拒 → 文件内容未被改写、子代理继续收尾
    const sidB = await newSession();
    const evB = await streamWithApprovals(sidB, '[[mock:m15-task]] 再来一次（这次拒绝子级写入）', 'deny');
    ok(evB.some(e => e.type === 'sub_event' && (e.ev as Record<string, unknown>).type === 'tool_denied'),
      'M15 拒绝路径：tool_denied 透传');
    ok(readFileSync(path.join(workdir, 'm15-note.txt'), 'utf8') === 'written-by-subagent',
      'M15 拒绝路径：文件未被改写（零落盘增量）');
    ok(evB.at(-1)?.type === 'finish', 'M15 拒绝路径正常 finish（拒绝不致命）');

    // ---- 13. 跨会话并行调度（M16：并行实证 + 全局上限排队）----
    // 用「挂起审批」占住两个全局槽：A/B 发 m15 剧本但暂不应答审批 → busy×2；
    // C 再发消息必然全局排队——scope=global 的 queued 帧本身就是 A/B 并行的证据
    const cfgP = await jfetch<{ maxParallelSessions?: number }>(`${BASE}/api/config`);
    ok(cfgP.body.maxParallelSessions === 2, '/api/config 暴露全局并发上限（WATER_MAX_PARALLEL_SESSIONS=2）');

    const mkSession = () => jfetch<{ id: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    }).then(r => r.body.id);
    const [sidPA, sidPB, sidPC] = await Promise.all([mkSession(), mkSession(), mkSession()]);

    let releaseHold!: () => void;
    const hold = new Promise<void>(r => { releaseHold = r; });
    /** 收流并在审批到达时先等 hold 再应答 once（主循环与子级审批都答）——挂起即占住全局槽 */
    const heldStream = async (sid: string): Promise<Array<Record<string, unknown>>> => {
      const events: Array<Record<string, unknown>> = [];
      const resp = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '[[mock:m15-task]] 占住并发槽（M16）' }),
      });
      if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(data); } catch { continue; }
          events.push(ev);
          const innerApproval = ev.type === 'approval_required'
            ? ev
            : ev.type === 'sub_event' && (ev.ev as Record<string, unknown>).type === 'approval_required'
              ? ev.ev as Record<string, unknown>
              : null;
          if (innerApproval) {
            await hold; // 挂起：占住全局槽直到外部放行
            await jfetch(`${BASE}/api/sessions/${sid}/approve`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ callId: innerApproval.callId, decision: 'once' }),
            });
          }
          if (ev.type === 'finish') return events;
        }
      }
      return events;
    };

    const streamsAB = [heldStream(sidPA), heldStream(sidPB)];
    // 轮询直到两会话同时 busy（各自 Loop 挂在审批上 = 两槽全被占）
    let bothBusy = false;
    for (let i = 0; i < 40 && !bothBusy; i++) {
      const list = await jfetch<{ sessions: Array<{ id: string; busy: boolean }> }>(`${BASE}/api/sessions`);
      bothBusy = [sidPA, sidPB].every(id => list.body.sessions.some(s => s.id === id && s.busy));
      if (!bothBusy) await new Promise(r => setTimeout(r, 150));
    }
    ok(bothBusy, 'M16 两会话同时运行（busy×2，全局两槽被占）');

    // C 发普通消息（glob 流，无需审批）→ 必然全局排队（无法 finish——槽被 A/B 占着）
    let cSawGlobalQueue = false;
    const streamC = (async (): Promise<Array<Record<string, unknown>>> => {
      const events: Array<Record<string, unknown>> = [];
      const resp = await fetch(`${BASE}/api/sessions/${sidPC}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '看看有什么文件（M16 排队验证）' }),
      });
      if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(data); } catch { continue; }
          events.push(ev);
          if (ev.type === 'queued' && (ev as { scope?: string }).scope === 'global') cSawGlobalQueue = true;
          if (ev.type === 'finish') return events;
        }
      }
      return events;
    })();
    for (let i = 0; i < 40 && !cSawGlobalQueue; i++) await new Promise(r => setTimeout(r, 150));
    ok(cSawGlobalQueue, 'M16 第三会话收到 scope=global 排队帧（A/B 并行占满上限的证据）');

    releaseHold(); // 放行 A/B 审批 → 槽位释放 → C 自动接续
    const [evA2, evB2, evC2] = await Promise.all([...streamsAB, streamC]);
    ok(evA2.at(-1)?.type === 'finish' && evB2.at(-1)?.type === 'finish' && evC2.at(-1)?.type === 'finish',
      'M16 放行后三个会话全部完成（排队者自动接续）');
    // 历史互不污染：各会话的用户消息只含自己发的文本
    const histOf = async (sid: string) => {
      const h = await jfetch<{ messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }> }>(`${BASE}/api/sessions/${sid}/messages`);
      return h.body.messages.filter(m => m.role === 'user')
        .map(m => m.parts.find(p => p.type === 'text')?.text ?? '').join('|');
    };
    const [hA, hB, hC] = await Promise.all([histOf(sidPA), histOf(sidPB), histOf(sidPC)]);
    ok(hC.includes('M16 排队验证') && !hC.includes('占住并发槽'), 'M16 C 的历史只含自己的消息');
    ok(hA.includes('占住并发槽') && !hA.includes('M16 排队验证'), 'M16 A 的历史未被 B/C 污染');
    ok(!hB.includes('M16 排队验证'), 'M16 B 的历史未被 C 污染');

    // ---- 14. 配置式声明工具（M17：声明→注册→模型调用→模板回填，prompt 型）----
    const perms17 = await jfetch<{ rules: Array<{ tool: string; risk: string }> }>(`${BASE}/api/permissions`);
    ok(perms17.body.rules.some(r => r.tool === 'seal' && r.risk === 'low'),
      'M17 /api/permissions 含配置式工具 seal（low：零执行逻辑）');
    const pl17 = await jfetch<{ configTools: Array<{ name: string; hasParameters: boolean }> }>(`${BASE}/api/plugins`);
    ok(pl17.body.configTools?.some(t => t.name === 'seal' && t.hasParameters),
      'M17 /api/plugins 列出配置式工具 seal（带参数声明）');
    const s17 = await jfetch<{ id: string }>(`${BASE}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const ev17 = await readSSE(`${BASE}/api/sessions/${s17.body.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '[[mock:m17tool:seal]] 调用配置式工具' }),
    });
    const pending17 = ev17.find(e => e.type === 'tool_pending') as { call?: { name?: string } } | undefined;
    ok(pending17?.call?.name === 'seal', 'M17 mock 按剧本调用 seal（tool_pending 可见）');
    const res17 = ev17.find(e => e.type === 'tool_result') as { result?: string; isError?: boolean } | undefined;
    ok(res17?.result === '已盖章：hello-m17' && res17.isError === false,
      'M17 prompt 型执行：模板 $text 展开为入参（结果回填实证）');
    ok(ev17.at(-1)?.type === 'finish', 'M17 场景正常 finish');

    // ---- 15. 审批回放统一（M19：主审批入缓冲 + 断开宽限重连不误杀）----
    const sid19 = await mkSession();
    const ac19 = new AbortController();
    const evBefore19: Array<Record<string, unknown>> = [];
    {
      // 发消息读到主循环审批帧后断开连接（模拟刷新页面）
      const resp = await fetch(`${BASE}/api/sessions/${sid19}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '[[mock:m15-task]] 演示断开重连（M19）' }),
        signal: ac19.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`SSE HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      readLoop: for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(data); } catch { continue; }
          evBefore19.push(ev);
          if (ev.type === 'approval_required') break readLoop;
        }
      }
      ac19.abort(); // 断开——宽限开始，Loop 挂在审批上继续存活
    }
    ok(evBefore19.some(e => e.type === 'approval_required'), 'M19 断开前收到主循环审批帧');
    // 断开后：审批帧已在回放缓冲（刷新接流可见）；运行未被断开误杀
    const rp19 = await jfetch<{ events: Array<{ seq: number; ev: Record<string, unknown> }>; busy: boolean }>(`${BASE}/api/sessions/${sid19}/events?since=0`);
    ok(rp19.body.events.some(e => e.ev.type === 'approval_required'), 'M19 主循环审批帧进回放缓冲（断开后可补帧）');
    ok(rp19.body.busy === true, 'M19 断开后宽限期内运行仍存活（busy，未被误杀）');
    // 重连（读 events 即重连信号）后放行主审批 → 子代理跑起来 → 子级审批照常入缓冲
    const okMain = await jfetch<{ ok: boolean }>(`${BASE}/api/sessions/${sid19}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId: 'mock-task-m15', decision: 'once' }),
    });
    ok(okMain.status === 200, 'M19 宽限期内审批端点放行主审批');
    const waitEv19 = async (pred: (ev: Record<string, unknown>) => boolean, ms = 8000): Promise<Record<string, unknown> | null> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const r = await jfetch<{ events: Array<{ seq: number; ev: Record<string, unknown> }> }>(`${BASE}/api/sessions/${sid19}/events?since=0`);
        const hit = r.body.events.find(e => pred(e.ev));
        if (hit) return hit.ev;
        await new Promise(r => setTimeout(r, 150));
      }
      return null;
    };
    const subAp19 = await waitEv19(ev => ev.type === 'sub_event'
      && (ev as { ev?: Record<string, unknown> }).ev?.type === 'approval_required');
    ok(Boolean(subAp19), 'M19 断开期间子级审批帧照常进缓冲');
    const subCallId = subAp19 ? ((subAp19 as { ev: { callId: string } }).ev.callId) : '';
    const okSub = await jfetch<{ ok: boolean }>(`${BASE}/api/sessions/${sid19}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId: subCallId, decision: 'once' }),
    });
    ok(okSub.status === 200 && okSub.body.ok, 'M19 重连后子级审批放行（namespaced callId）');
    const fin19 = await waitEv19(ev => ev.type === 'finish');
    ok(Boolean(fin19), 'M19 断开→重连→审批→运行完整结束（回放里可见 finish）');
    const list19 = await jfetch<{ sessions: Array<{ id: string; busy: boolean }> }>(`${BASE}/api/sessions`);
    ok(list19.body.sessions.find(x => x.id === sid19)?.busy === false, 'M19 结束后会话解除 busy（宽限定时器清理）');

    // ---- 16. HTTP 型配置工具（M22：白名单 + $env: 凭据插值 + high 审批 + 出网回填）----
    const perms22 = await jfetch<{ rules: Array<{ tool: string; risk: string }> }>(`${BASE}/api/permissions`);
    ok(perms22.body.rules.some(r => r.tool === 'ping-api' && r.risk === 'high'),
      'M22 /api/permissions 含 ping-api（high：出网逐次审批）');
    const pl22 = await jfetch<{ configTools: Array<{ name: string; kind: string }> }>(`${BASE}/api/plugins`);
    ok(pl22.body.configTools?.some(t => t.name === 'ping-api' && t.kind === 'http'),
      'M22 /api/plugins 列出 ping-api（kind=http）');
    const sid22 = await mkSession();
    const ev22 = await streamWithApprovals(sid22, '[[mock:m17tool:ping-api]] 调用 http 工具', 'once');
    const res22 = ev22.find(e => e.type === 'tool_result'
      && (e.call as Record<string, unknown> | undefined)?.name === 'ping-api') as { result?: string; isError?: boolean } | undefined;
    ok(Boolean(res22) && res22!.result!.includes('HTTP 200') && res22!.result!.includes('"echo":"hello-m17"'),
      'M22 http 型执行：$text 插值出网、mock server 响应回填');
    ok(res22?.isError === false && ev22.at(-1)?.type === 'finish', 'M22 场景正常完成（high 审批经审批桥放行）');
    ok(seenHttp.some(x => x.q === 'hello-m17' && x.auth === 'Bearer e2e-demo-token'),
      'M22 $env: 凭据插值到达服务端（token 只存在于服务端环境，不入 config/事件流）');

    // ---- 18. 同轮工具并发执行（M27：[[mock:parallel]] 一轮两个 write）----
    const sidP = await mkSession();
    const evP = await streamWithApprovals(sidP, '[[mock:parallel]] 一轮并发写两个文件', 'once');
    ok(evP.filter(e => e.type === 'tool_pending').length === 2, 'M27 同轮两个 tool_pending（并发发起）');
    const resP = evP.filter(e => e.type === 'tool_result');
    ok(resP.length === 2 && resP.every(r => !(r as { isError?: boolean }).isError), 'M27 两个并发结果均成功（allSettled）');
    ok(existsSync(path.join(workdir, 'para-a.txt')) && existsSync(path.join(workdir, 'para-b.txt')),
      'M27 两文件真实落盘（并发写入互不干扰）');
    ok(evP.at(-1)?.type === 'finish', 'M27 并发轮正常 finish');
    const repP = await jfetch<{ events: Array<{ seq: number; ev: Record<string, unknown> }> }>(`${BASE}/api/sessions/${sidP}/events?since=0`);
    ok(repP.body.events.filter(e => e.ev.type === 'tool_result').length === 2,
      'M27 回放含两个 tool_result（并发到达序 seq 化，回放一致）');

    // ---- 17. BYOK：Web 端安全录入 API Key（#67：收 key 不收 baseUrl）----
    // 主 server 是 mock（hasKey 恒真，测不出动态性）——起第二个「无凭据非 mock」server：
    // 验证无 key 也能启动（BYOK 留口）+ hasKey 动态翻转 + 任何响应永不回显完整 key 值
    {
      const PORT2 = 3218;
      const BASE2 = `http://127.0.0.1:${PORT2}`;
      const wd3 = mkdtempSync(path.join(tmpdir(), 'water-e2e3-'));
      const env2: NodeJS.ProcessEnv = { ...process.env };
      delete env2.WATER_MOCK; delete env2.ZHIPU_API_KEY;
      delete env2.DEEPSEEK_API_KEY; delete env2.WATER_API_KEY_ENV;
      env2.WATER_PORT = String(PORT2);
      const child2 = spawn(process.execPath, [SERVER], {
        env: env2, cwd: wd3, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      child2.stdout.on('data', () => { /* 吞掉启动日志 */ });
      child2.stderr.on('data', () => { /* BYOK 启动警告为预期行为 */ });
      try {
        let ready2 = false;
        for (let i = 0; i < 50; i++) {
          try { const r = await fetch(`${BASE2}/api/config`); if (r.ok) { ready2 = true; break; } } catch { /* 未就绪 */ }
          await new Promise(r => setTimeout(r, 200));
        }
        ok(ready2, 'BYOK 无凭据可启动（行为变更：不再拒绝，等 Web 录入）');
        if (ready2) {
          const cfg0 = await jfetch<{ hasKey: boolean }>(`${BASE2}/api/config`);
          ok(cfg0.body.hasKey === false, 'BYOK 初始：/api/config hasKey=false');
          const m0 = await jfetch<{ models: Array<{ id: string; hasKey: boolean }> }>(`${BASE2}/api/models`);
          ok(m0.body.models.every(m => !m.hasKey), 'BYOK 初始：全部模型缺凭据（非 mock 真实判定）');
          const k0 = await jfetch<{ keys: Array<{ apiKeyEnv: string; source: string }> }>(`${BASE2}/api/keys`);
          ok(k0.body.keys.some(k => k.apiKeyEnv === 'ZHIPU_API_KEY' && k.source === 'none')
            && k0.body.keys.some(k => k.apiKeyEnv === 'DEEPSEEK_API_KEY' && k.source === 'none'),
            'BYOK /api/keys 列出注册表出现的 env 名（去重）');

          const FAKE = 'e2e-fake-dsk-987654321'; // 形状合法的假 key（非真实凭据）
          const set1 = await jfetch<{ ok: boolean; hint: string }>(`${BASE2}/api/keys`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKeyEnv: 'DEEPSEEK_API_KEY', value: FAKE }),
          });
          ok(set1.status === 200 && set1.body.ok && set1.body.hint === '…4321', 'BYOK 录入成功，只回显尾4位');
          const m1 = await jfetch<{ models: Array<{ id: string; hasKey: boolean }> }>(`${BASE2}/api/models`);
          ok(m1.body.models.find(m => m.id === 'deepseek-chat')?.hasKey === true, 'BYOK 后 deepseek-chat hasKey 动态翻转');
          ok(m1.body.models.find(m => m.id === 'glm-4.6')?.hasKey === false, 'BYOK 不串扰其他 env（glm-4.6 仍缺）');
          const k1 = await jfetch<{ keys: Array<{ apiKeyEnv: string; source: string; hint: string | null }> }>(`${BASE2}/api/keys`);
          const dsk = k1.body.keys.find(k => k.apiKeyEnv === 'DEEPSEEK_API_KEY');
          ok(dsk?.source === 'byok' && dsk?.hint === '…4321', 'BYOK /api/keys 来源 byok + 尾4位提示');
          ok(!JSON.stringify(k1.body).includes(FAKE) && !JSON.stringify(m1.body).includes(FAKE),
            'BYOK 任何响应不含完整 key 值');

          const bad1 = await jfetch<{ error?: string }>(`${BASE2}/api/keys`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKeyEnv: 'deepseek-key', value: FAKE }),
          });
          ok(bad1.status === 400, 'BYOK 拒绝非法 env 名（小写，防把 key 值当名字存）');
          const bad2 = await jfetch<{ error?: string }>(`${BASE2}/api/keys`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKeyEnv: 'DEEPSEEK_API_KEY', value: 'short' }),
          });
          ok(bad2.status === 400, 'BYOK 拒绝过短 value');

          const del1 = await jfetch<{ ok: boolean }>(`${BASE2}/api/keys/DEEPSEEK_API_KEY`, { method: 'DELETE' });
          ok(del1.status === 200 && del1.body.ok, 'BYOK 清除成功');
          const m2 = await jfetch<{ models: Array<{ id: string; hasKey: boolean }> }>(`${BASE2}/api/models`);
          ok(m2.body.models.find(m => m.id === 'deepseek-chat')?.hasKey === false, 'BYOK 清除后 hasKey 回落');
          const del2 = await jfetch<{ error?: string }>(`${BASE2}/api/keys/DEEPSEEK_API_KEY`, { method: 'DELETE' });
          ok(del2.status === 404, 'BYOK 重复清除 404（env 来源不可在此清）');
        }
      } finally {
        child2.kill();
        await Promise.race([
          new Promise<void>(res => child2.once('exit', res)),
          new Promise<void>(res => setTimeout(res, 3000)),
        ]);
        try { rmSync(wd3, { recursive: true, force: true }); }
        catch { /* 清理失败不影响结果：留在 %TEMP% 由系统回收 */ }
      }
    }

    console.log(`\n${failed === 0 ? '✅ E2E PASS' : `❌ E2E FAIL（${failed} 项）`}`);
  } finally {
    // 等子进程真正退出再清临时目录（Windows 下进程 cwd 会锁目录，立刻删必 EPERM）
    child.kill();
    await Promise.race([
      new Promise<void>(res => child.once('exit', res)),
      new Promise<void>(res => setTimeout(res, 3000)),
    ]);
    mockHttp.close();
    try { rmSync(workdir, { recursive: true, force: true }); }
    catch { /* 清理失败不影响结果：留在 %TEMP% 由系统回收 */ }
    try { rmSync(workdir2, { recursive: true, force: true }); }
    catch { /* 同上 */ }
  }
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('E2E 异常:', e); process.exit(1); });
