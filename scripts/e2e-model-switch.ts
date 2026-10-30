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
  // M13：配置式命令——测试注入的临时 config.json（含展开验证用模板）
  const cfgFile = path.join(workdir, 'test-config.json');
  writeFileSync(cfgFile, JSON.stringify({
    commands: [{ name: 'say', template: '请原样输出以下内容：[$ARGUMENTS]', description: '回显命令' }],
  }), 'utf8');
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, WATER_MOCK: '1', WATER_PORT: String(PORT),
      WATER_WORKSPACES: workdir2, WATER_CONFIG_FILE: cfgFile,
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
    // 两条并发：第一条立即执行，第二条排队（position=1）后自动执行
    const [r1, r2] = await Promise.all([
      readSSE(`${BASE}/api/sessions/${sq.body.id}/messages`, postMsg('第一条消息')),
      readSSE(`${BASE}/api/sessions/${sq.body.id}/messages`, postMsg('第二条消息')),
    ]);
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
    try { rmSync(workdir2, { recursive: true, force: true }); }
    catch { /* 同上 */ }
  }
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('E2E 异常:', e); process.exit(1); });
