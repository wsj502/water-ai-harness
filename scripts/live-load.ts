/**
 * M29 live 长连接多客户端压测与兼容性观察（#90；mock 离线、可复现）。
 *
 * 回答四个此前只有设计论证、没有行为数据的问题：
 *   S1 多观察者扇出：20 个 live 观察者（错峰 since）是否全员收齐、finish 到达离散度多大
 *   S2 断线恢复（代理掐线模拟）：忙中途 abort 部分观察者——幸存者是否受影响、
 *      断线者带 since=lastSeq 重连是否「无缺无重」恰好衔接
 *   S3 排队协同：并发上限默认 3，5 会话齐发——queued 在写者流与 live（M31 瞬时广播）均可见；
 *      观察者在各自运行开始后挂载是否收齐；空闲会话 live「补完即关」形态确认
 *   S5 多轮单连接（M31）：同会话连发两条——一条 live 连接看完整场：第一轮全帧 →
 *      queued 瞬时帧（无 id）→ 第二轮（seq 从 1 重计，跨轮游标）→ 排空收流
 *   S4 keepalive 实测：轮次间静默窗 >15s 时观察者是否真的收到 ping 注释帧（防代理空闲掐线的实证）
 *
 * 前置：npm run build（压测对象为 dist 构建产物，与 e2e/smoke 同约定）
 * 运行：npx tsx scripts/live-load.ts
 *
 * 端口：3293/3294（避开容器 3210 / e2e 3217-3218 / smoke 3291）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'apps', 'server', 'dist', 'index.js');
const T0 = performance.now();
const now = () => Math.round(performance.now() - T0);

let failed = 0;
function ok(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

async function jfetch<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) as T };
}

/** live 观察者：GET /stream 的可断线客户端。记录每帧到达时刻（延迟测量的基础）。
 *  M31 起瞬时事件（queued）无 id 帧——seq 记为 null，不参与 lastSeq 游标语义。 */
class Live {
  readonly frames: Array<{ seq: number | null; type: string; t: number }> = [];
  pings = 0;
  /** 挂载时刻（构造瞬间，用于首帧延迟测量——在循环外统一记录会得到负数） */
  attachAt = 0;
  private ctrl = new AbortController();
  private doneP: Promise<void>;
  constructor(base: string, sid: string, since: number) {
    this.doneP = (async () => {
      const resp = await fetch(`${base}/api/sessions/${sid}/stream?since=${since}`, { signal: this.ctrl.signal });
      if (!resp.ok || !resp.body) throw new Error(`live HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (/^event: ping$/m.test(frame)) { this.pings++; continue; }
          const idLine = frame.split('\n').find(l => l.startsWith('id:'));
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          try {
            const ev = JSON.parse(data) as { type: string };
            this.frames.push({ seq: idLine ? Number(idLine.slice(3).trim()) : null, type: ev.type, t: now() });
          } catch { /* 坏帧跳过 */ }
        }
      }
    })().catch(() => { /* abort/断线：观察者侧正常收尾 */ });
  }
  get lastSeq(): number { return this.frames.filter(f => f.seq !== null).at(-1)?.seq ?? 0; }
  get sawFinish(): boolean { return this.frames.some(f => f.type === 'finish'); }
  abort(): void { this.ctrl.abort(); }
  /** 等待流自然结束（非 busy 补完即关 / busy 到 finish 后服务端收尾） */
  async waitEnd(ms: number): Promise<boolean> {
    return await Promise.race([this.doneP.then(() => true), new Promise<false>(r => setTimeout(() => r(false), ms))]);
  }
  async waitFrames(n: number, ms: number): Promise<boolean> {
    const t0 = performance.now();
    while (this.frames.length < n) {
      if (performance.now() - t0 > ms) return false;
      await new Promise(r => setTimeout(r, 30));
    }
    return true;
  }
}

/** POST 写者：读到 finish（与 smoke/e2e 同构），返回全部事件 */
async function postToFinish(base: string, sid: string, text: string): Promise<Array<{ type: string }>> {
  const resp = await fetch(`${base}/api/sessions/${sid}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (!resp.ok || !resp.body) throw new Error(`POST HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ type: string }> = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, idx).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      buf = buf.slice(idx + 2);
      if (!data) continue;
      try {
        const ev = JSON.parse(data) as { type: string };
        events.push(ev);
        if (ev.type === 'finish') return events;
      } catch { /* 跳过 */ }
    }
  }
  return events;
}

async function startServer(port: number, extraEnv: Record<string, string> = {}): Promise<{ base: string; child: ChildProcess; workdir: string; stop: () => Promise<void> }> {
  const workdir = mkdtempSync(path.join(tmpdir(), `water-live-load-${port}-`));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, WATER_MOCK: '1', WATER_PORT: String(port), ...extraEnv },
    cwd: workdir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 75; i++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* 未就绪 */ }
    if (i === 74) throw new Error(`server :${port} 15s 内未就绪`);
    await new Promise(r => setTimeout(r, 200));
  }
  return { base, child, workdir, stop: async () => { child.kill(); await new Promise(r => setTimeout(r, 150)); rmSync(workdir, { recursive: true, force: true }); } };
}

async function newSession(base: string): Promise<string> {
  const s = await jfetch<{ id: string }>(`${base}/api/sessions`, { method: 'POST' });
  if (s.status !== 201) throw new Error('会话创建失败');
  return s.body.id;
}

/** 等回放缓冲出现 n 条（POST 发出后首轮节奏落地，观察者挂载窗口打开） */
async function waitBuffered(base: string, sid: string, n: number, ms: number): Promise<boolean> {
  const t0 = performance.now();
  for (;;) {
    const r = await jfetch<{ events: unknown[] }>(`${base}/api/sessions/${sid}/events?since=0`);
    if (r.body.events.length >= n) return true;
    if (performance.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  if (!existsSync(SERVER)) throw new Error(`未找到 ${SERVER}——先 npm run build`);

  // ============ S1/S2/S3 共用实例：RTT 800ms（忙窗口 ~2s，足够挂载观察者） ============
  const srv = await startServer(3293, { WATER_MOCK_RTT_MS: '800' });
  try {
    // ---- S1：单 busy 会话 × 20 观察者（错峰 since：一半 0，一半中途 seq）----
    section('S1 多观察者扇出（20 live 观察者，错峰 since）');
    const sid1 = await newSession(srv.base);
    const writer1 = postToFinish(srv.base, sid1, '看看有什么文件');
    if (!await waitBuffered(srv.base, sid1, 2, 5000)) throw new Error('S1：忙窗口未开启');
    const midSeq = Math.max(1, (await jfetch<{ events: Array<{ seq: number }> }>(`${srv.base}/api/sessions/${sid1}/events?since=0`)).body.events.length - 1);
    const observers: Live[] = [];
    for (let i = 0; i < 20; i++) {
      const o = new Live(srv.base, sid1, i % 2 === 0 ? 0 : midSeq);
      o.attachAt = now();
      observers.push(o);
      await new Promise(r => setTimeout(r, 15)); // 错峰挂载，避免只在「同一毫秒连接」上测扇出
    }
    const writerEvents = await writer1;
    const ends = await Promise.all(observers.map(o => o.waitEnd(8000)));
    const maxSeqs = observers.map(o => o.lastSeq);
    ok(ends.every(Boolean) && observers.every(o => o.sawFinish), '20 观察者全部收到 finish 且流正常收尾');
    ok(new Set(maxSeqs).size === 1 && maxSeqs[0] === writerEvents.length, `全员 max seq 一致且等于写者帧数（${maxSeqs[0]}）`);
    const firstLat = observers.map(o => o.frames[0]!.t - o.attachAt).sort((a, b) => a - b);
    const finishT = observers.map(o => o.frames.find(f => f.type === 'finish')!.t).sort((a, b) => a - b);
    console.log(`  · 首帧延迟 p50 ${firstLat[Math.floor(firstLat.length / 2)]}ms / max ${firstLat.at(-1)}ms；finish 到达离散度 ${finishT.at(-1)! - finishT[0]!}ms（${writerEvents.length} 帧）`);

    // ---- S2：断线恢复——8 观察者中途 abort 3 个，断线者带 lastSeq 重连 ----
    section('S2 断线恢复（模拟代理掐线：中途 abort 3/8 观察者）');
    const sid2 = await newSession(srv.base);
    const writer2 = postToFinish(srv.base, sid2, '看看有什么文件');
    if (!await waitBuffered(srv.base, sid2, 2, 5000)) throw new Error('S2：忙窗口未开启');
    const obs2 = Array.from({ length: 8 }, () => new Live(srv.base, sid2, 0));
    const aborted = obs2.slice(0, 3);
    const survivors = obs2.slice(3);
    if (!await Promise.all(aborted.map(o => o.waitFrames(2, 8000))).then(r => r.every(Boolean))) throw new Error('S2：观察者未收到帧');
    aborted.forEach(o => o.abort()); // 掐线
    const writer2Events = await writer2;
    ok(writer2Events.at(-1)?.type === 'finish', '掐线后写者照常完成（live 断开不触发宽限——观察者与写者分离）');
    const ends2 = await Promise.all(survivors.map(o => o.waitEnd(8000)));
    ok(ends2.every(Boolean) && survivors.every(o => o.sawFinish && o.lastSeq === writer2Events.length), '幸存 5 观察者不受影响，收齐 finish');
    // 断线者恢复：since=掐线时的 lastSeq → 补帧应恰好衔接（无缺无重）
    let resumeExact = true;
    for (const o of aborted) {
      const resume = new Live(srv.base, sid2, o.lastSeq);
      await resume.waitEnd(5000);
      const seqs = resume.frames.map(f => f.seq);
      if (seqs.length === 0 || seqs[0] !== o.lastSeq + 1 || !seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)) resumeExact = false;
      if (resume.lastSeq !== writer2Events.length) resumeExact = false;
    }
    ok(resumeExact, `断线者 since=lastSeq 重连补帧恰好衔接（首个 seq = lastSeq+1，终值 ${writer2Events.length}）`);

    // ---- S3：排队协同——5 会话齐发（默认并发上限 3 → 2 排队）× 各 2 观察者 ----
    // M31 起 queued 瞬时帧也广播给 live 观察者（见 S5）；本节仍验证写者流可见性与
    // 运行开始后挂载的收齐行为（挂载窗口语义不变：等该会话运行开始再挂）。
    section('S3 排队协同（5 会话齐发 × 各 2 观察者，上限默认 3）');
    const s3 = await Promise.all(Array.from({ length: 5 }, () => newSession(srv.base)));
    const writers3 = s3.map(id => postToFinish(srv.base, id, '看看有什么文件'));
    const attachAfterStart = async (id: string): Promise<Live[]> => {
      await waitBuffered(srv.base, id, 1, 15000); // 等该会话运行开始（排队会话在此期间等待）
      return [new Live(srv.base, id, 0), new Live(srv.base, id, 0)];
    };
    const obsBySession = await Promise.all(s3.map(id => attachAfterStart(id)));
    const obs3 = obsBySession.flat();
    const writers3Events = await Promise.all(writers3);
    const replayLen = (ev: Array<{ type: string }>) => ev.filter(e => e.type !== 'queued').length; // queued 不进回放缓冲
    const ends3 = await Promise.all(obs3.map(o => o.waitEnd(10000)));
    ok(writers3Events.every(ev => ev.at(-1)?.type === 'finish'), '5 会话运行全部完成（含 2 个排队后执行）');
    ok(ends3.every(Boolean) && obs3.every((o, k) => o.sawFinish && o.lastSeq === replayLen(writers3Events[Math.floor(k / 2)]!)),
      '10 观察者各自收齐所属会话全帧（排队会话在运行开始后挂载）');
    const queuedOnWriter = writers3Events.filter(ev => ev.some(e => e.type === 'queued')).length;
    ok(queuedOnWriter >= 2, `排队事件在写者流可见（含 queued 帧的写者流 ${queuedOnWriter} 个，≥ 排队会话数 2）`);
    // 附带观察：空闲会话挂 live → 「非 busy 且无排队：补完即关」的观察者侧形态（0 帧即关）
    const idle = await newSession(srv.base);
    const idleObs = new Live(srv.base, idle, 0);
    ok(await idleObs.waitEnd(3000) && idleObs.frames.length === 0, '空闲会话 live 补完即关（0 帧，观察者侧语义确认）');

    // ---- S5（M31）：多轮单连接观察——同会话连发两条，一条 live 连接看完整场 ----
    section('S5 多轮单连接观察（M31：排队衔接 + 瞬时帧 + 跨轮游标）');
    const sid5 = await newSession(srv.base);
    const writer5a = postToFinish(srv.base, sid5, '看看有什么文件');
    if (!await waitBuffered(srv.base, sid5, 1, 5000)) throw new Error('S5：首轮未开始');
    const obs5 = new Live(srv.base, sid5, 0); // 第一轮进行中挂载
    const writer5b = postToFinish(srv.base, sid5, '再看看'); // 排在第一条后面
    const [evA, evB] = await Promise.all([writer5a, writer5b]);
    await obs5.waitEnd(8000); // 队列排空（第二条 finish 写完且 pending=0）才收流
    const finishes = obs5.frames.filter(f => f.type === 'finish');
    ok(finishes.length === 2, '单连接观察到两次 finish（多轮 hold 语义）');
    const transient = obs5.frames.filter(f => f.seq === null);
    ok(transient.some(f => f.type === 'queued'), `排队瞬时帧（无 id）到达观察者（${transient.length} 帧）`);
    // 跨轮游标：第一轮 seq 1..N，第二轮 seq 重新从 1 计（陈旧游标回退为当前轮全量）
    const seqs = obs5.frames.filter(f => f.seq !== null).map(f => f.seq as number);
    const firstRunLen = evA.filter(e => e.type !== 'queued').length;
    ok(seqs.slice(0, firstRunLen).every((v, i) => v === i + 1) && seqs[firstRunLen] === 1,
      `跨轮游标：第一轮 seq 1..${firstRunLen}，第二轮从 1 重计（观察者无缺帧）`);
    ok(obs5.lastSeq === evB.filter(e => e.type !== 'queued').length, `最终游标 = 第二轮帧数（${evB.filter(e => e.type !== 'queued').length}）`);
  } finally {
    await srv.stop();
  }

  // ============ S4：keepalive 实测——RTT 16s → 轮次间静默窗 ~16s > 15s，应收到 ping ============
  // 注意挂载时机：必须在运行开始后（busy 中）挂载——排队/空闲期挂载会触发
  // 「非 busy 补完即关」，首版就在这里栽过（attach 早于 busy 建立，流秒关）。
  section('S4 keepalive 实测（RTT 16s，轮次间静默 ~16s）');
  const srv4 = await startServer(3294, { WATER_MOCK_RTT_MS: '16000' });
  try {
    const sid4 = await newSession(srv4.base);
    const writer4 = postToFinish(srv4.base, sid4, '看看有什么文件');
    if (!await waitBuffered(srv4.base, sid4, 1, 30000)) throw new Error('S4：忙窗口未开启');
    const observer4 = new Live(srv4.base, sid4, 0);
    const writer4Events = await writer4; // ~2×16s
    await observer4.waitEnd(8000);
    ok(observer4.sawFinish && observer4.lastSeq === writer4Events.length, '慢剧本全帧收齐');
    ok(observer4.pings >= 1, `静默窗内收到 keepalive ping ${observer4.pings} 个（15s 间隔防代理空闲掐线）`);
  } finally {
    await srv4.stop();
  }

  console.log(failed === 0 ? '\nlive 压测与兼容性观察全绿 ✅' : `\n${failed} 条断言失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
