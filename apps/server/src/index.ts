/**
 * Water Server — HTTP + SSE 会话协议。
 *
 * 端点：
 *   GET  /api/config                 当前 provider/model 配置（无凭据）
 *   GET  /api/sessions               会话列表
 *   POST /api/sessions               新建会话
 *   POST /api/sessions/:id/messages  发送消息 → SSE 返回 LoopEvent 流
 *   POST /api/sessions/:id/approve   审批悬挂的工具调用 {callId, decision}
 *
 * 运行：
 *   WATER_MOCK=1 npm run dev -w apps/server            # 离线模式
 *   start-secure.ps1 -- npx tsx apps/server/src/index.ts  # 注入 GLM 凭据
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  agentLoop, builtinTools, compactMessages, configHttpToolToTool, configToolToTool, createProvider, estimateMessagesTokens, loadPlugins,
  loadFileConfig, MockProvider, ProviderRegistry, resolveConfig, BUILTIN_MODELS, mergeModels,
  PROTOCOL_DEFAULTS, PROTOCOL_LABEL,
  type PluginRegistry, type Provider, type ToolUsePart,
} from '@water/core';
import { SessionStore, type ApprovalDecision, type Session, type SessionProtocol, type TaskRecord, type TaskStep } from './session.js';
import { SessionPersistence } from './persistence.js';
import { ParallelGate } from './gate.js';
import { loadWorkspaces, type WorkspaceInfo } from './workspaces.js';

const cfg = resolveConfig({});
const mock = process.env.WATER_MOCK === '1';
if (!mock && !cfg.apiKey) {
  // BYOK（#67）：无环境凭据不再拒绝启动——Web 设置页可录入（存内存）；真实调用前仍会被 acquire 拦下
  console.warn(`⚠ 未检测到 ${cfg.apiKeyEnv}。服务照常启动：可在 Web「设置 → API 密钥」录入（BYOK），或配置环境变量 / WATER_MOCK=1 后重启。`);
}

/**
 * BYOK 凭据库（#67）：Web 端录入的 API Key，只存进程内存——
 * 永不落盘、永不进日志、重启即清（UI 明示）。优先级：BYOK > 进程环境变量。
 * 红线不变：前端仍不能指定 baseUrl，key 只发往注册表内模型声明的端点。
 */
const byokKeys = new Map<string, string>();
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** 凭据读取通道：BYOK 内存 > 环境变量（start-secure 注入 / .env+compose）。值永不出服务端 */
const apiKeyOf = (envName: string): string | null => byokKeys.get(envName) ?? process.env[envName] ?? null;

/**
 * M1 模型注册表：内置模型 + ~/.water/config.json models[] 自定义模型。
 * Provider 实例按 (protocol, baseUrl, apiKeyEnv) 缓存，多会话共享。
 */
const fileCfg = loadFileConfig();
const registry = new ProviderRegistry(
  mergeModels(BUILTIN_MODELS, fileCfg.models ?? []),
  {
    baseUrlOf: p => process.env.WATER_BASE_URL ?? fileCfg.baseUrl ?? PROTOCOL_DEFAULTS[p].baseUrl,
    apiKeyOf,
  },
);

const mockProvider = new MockProvider();

// M16：全局并行闸门——会话间并行的并发上限（默认 3；WATER_MAX_PARALLEL_SESSIONS 可调）
const MAX_PARALLEL_SESSIONS = Math.max(1, Number(process.env.WATER_MAX_PARALLEL_SESSIONS) || 3);
const parallelGate = new ParallelGate(MAX_PARALLEL_SESSIONS);

// M19：断开宽限期——SSE 断开不再立即中断运行；期内重连（events 端点读取即视为重连）可继续，
// 超时才中断 Loop + 全拒（安全兜底不放松）。设为 0 回到「断开即中断」的旧语义
const graceMs = Number(process.env.WATER_APPROVAL_GRACE_MS);
const APPROVAL_GRACE_MS = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 60_000;

// ---- SYSTEM prompt（M2）：env WATER_SYSTEM > config.json systemPrompt > 内置默认 ----
// M7B：AGENTS.md 按工作区加载——SYSTEM 成为「全局基底 + 各工作区项目上下文」的组合
const DEFAULT_SYSTEM = [
  '你是 Water，一个工作在当前代码仓库里的 AI 编程助手。',
  '可用工具：read/write/edit/grep/glob/shell。优先小步快跑，改动前先读代码。',
  '回答使用中文，简洁、直接、技术导向。',
].join('\n');
const SYSTEM_BASE = process.env.WATER_SYSTEM ?? fileCfg.systemPrompt ?? DEFAULT_SYSTEM;

function buildSystem(root: string): { system: string; hasAgents: boolean } {
  const agentsPath = path.join(root, 'AGENTS.md');
  const agentsMd = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8').slice(0, 8000) : null;
  return agentsMd
    ? { system: `${SYSTEM_BASE}\n\n# 项目上下文（工作区 AGENTS.md）\n${agentsMd}`, hasAgents: true }
    : { system: SYSTEM_BASE, hasAgents: false };
}

// ---- 工作区注册表（M7B）----
const workspaces = loadWorkspaces(cfg.cwd);
/** 会话的工作区：绑定 id 查注册表，未绑定/失联回退 default（白名单校验天然防目录逃逸） */
function findWorkspace(id?: string | null): WorkspaceInfo {
  return workspaces.find(w => w.id === id) ?? workspaces.find(w => w.default)!;
}
const SYSTEM_BY_WS = new Map(workspaces.map(w => [w.id, buildSystem(w.path)]));

/** 会话生效的上下文预算：强制 env > 模型注册表窗口 × 0.8（M2） */
function contextBudget(s: Session): number | undefined {
  const forced = Number(process.env.WATER_MAX_CONTEXT_TOKENS) || 0;
  if (forced > 0) return forced;
  const info = registry.find(s.model ?? cfg.model);
  return info?.contextWindow ? Math.floor(info.contextWindow * 0.8) : undefined;
}

/** 内置斜杠命令（M2）：本地处理不进模型。返回回复文本；非内置命令返回 null */
function runBuiltinCommand(text: string, s: Session): string | null {
  const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  const cmd = m[1]!, arg = m[2]!.trim();
  switch (cmd) {
    case 'model': {
      const cur = s.model ?? cfg.model;
      if (!arg) {
        const lines = registry.list().map(mi => {
          const envName = mi.apiKeyEnv ?? PROTOCOL_DEFAULTS[mi.protocol].apiKeyEnv;
          const ready = mock || apiKeyOf(envName) !== null;
          return `- ${mi.id} [${PROTOCOL_LABEL[mi.protocol]}]${mi.thinking ? ' 💭' : ''}${ready ? '' : '（缺凭据 ' + envName + '）'}${mi.id === cur ? ' ← 当前' : ''}`;
        });
        return `可用模型（/model <id> 切换本会话）：\n${lines.join('\n')}\n当前：${cur}${s.model ? '（会话覆盖）' : '（服务端默认）'}`;
      }
      const err = applySessionConfig(s, { model: arg });
      if (err) return err;
      store.save(s);
      return `已切换本会话模型 → ${s.model}（${s.protocol}）`;
    }
    case 'compact': {
      const budget = contextBudget(s) ?? Infinity;
      const comp = compactMessages(s.messages, budget);
      if (!comp.compacted) {
        return `无需压缩：估算 ${estimateMessagesTokens(s.messages)} token，预算 ${budget === Infinity ? '（未配置，跟随模型窗口）' : budget}`;
      }
      store.save(s);
      return `上下文已压缩：估算 ${comp.estBefore} → ${comp.estAfter} token（丢弃 ${comp.droppedMessages} 条旧消息，截断 ${comp.truncatedResults} 条工具结果）`;
    }
    case 'system': {
      const ws = findWorkspace(s.workspaceId);
      const built = SYSTEM_BY_WS.get(ws.id)!;
      return `当前生效 SYSTEM（工作区 ${ws.id}${built.hasAgents ? '，含其 AGENTS.md' : ''}，前 600 字预览）：\n${built.system.slice(0, 600)}${built.system.length > 600 ? '\n…' : ''}`;
    }
    default:
      return null; // 交给插件命令
  }
}

/** 会话运行时：把「会话覆盖 + 服务端默认」解析成一次可执行的 provider 调用 */
type SessionRuntime = { protocol: string; model: string; provider: Provider; contextWindow?: number } | { error: string };

function sessionRuntime(s: Session): SessionRuntime {
  if (mock) {
    const cw = registry.find(s.model ?? cfg.model)?.contextWindow;
    return { protocol: 'mock', model: s.model ?? cfg.model, provider: mockProvider, ...(cw !== undefined ? { contextWindow: cw } : {}) };
  }
  const model = s.model ?? cfg.model;
  const info = registry.find(model);
  if (info) {
    const acq = registry.acquire(info);
    return acq.ok
      ? { protocol: info.protocol, model: info.id, provider: acq.provider, ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}) }
      : { error: acq.error };
  }
  if (s.model) {
    return { error: `未知模型 ${s.model}（自定义模型可能已被移除），请在模型菜单重选` };
  }
  // 兼容路径：默认模型不在注册表（老配置只写了 baseUrl/model、没写 models[]）→ 按启动配置手工构造
  // BYOK（#67）：凭据判定统一走 apiKeyOf（BYOK > env）
  if (apiKeyOf(cfg.apiKeyEnv) === null) return { error: `缺少凭据 ${cfg.apiKeyEnv}` };
  return { protocol: cfg.protocol, model: cfg.model, provider: createProvider({ protocol: cfg.protocol, baseUrl: cfg.baseUrl, apiKey: apiKeyOf(cfg.apiKeyEnv)! }) };
}

const store = new SessionStore(new SessionPersistence(cfg.cwd));
const app = new Hono();

// 插件注册表在 main() 里异步加载（避免顶层 await，兼容 CJS/SEA 打包）
let plugins: PluginRegistry = { plugins: [], tools: [], commands: [], hooks: [] };
// M17/M22：配置式声明工具——config.json tools[] 直接进注册表；重名即拒（启动期暴露）。
// prompt 型零副作用（low）；http 型出网（high 逐次审批，域名白名单已在 loadFileConfig 校验）
const configToolWrappers = (fileCfg.tools ?? []).map(t =>
  t.kind === 'http' ? configHttpToolToTool(t) : configToolToTool(t));
for (const t of configToolWrappers) {
  const clash = builtinTools.some(b => b.spec.name === t.spec.name)
    || configToolWrappers.some(o => o !== t && o.spec.name === t.spec.name);
  if (clash) throw new Error(`配置式工具名冲突: ${t.spec.name}（不能与内置或其他声明重名）`);
}
let allTools = [...builtinTools, ...configToolWrappers];

app.use('/api/*', cors());

app.get('/api/config', c => c.json({
  protocol: mock ? 'mock' : cfg.protocol,
  baseUrl: mock ? '(mock)' : cfg.baseUrl,
  model: cfg.model,
  workspace: cfg.cwd,
  version: '0.8.0',
  // M16：跨会话并发上限（会话间并行、超限跨会话排队）
  maxParallelSessions: MAX_PARALLEL_SESSIONS,
  // 只暴露「有没有」，永不暴露 key 本身（BYOK 后默认模型凭据就绪也计入）
  hasKey: mock || apiKeyOf(cfg.apiKeyEnv) !== null,
  apiKeyEnv: cfg.apiKeyEnv,
}));

/**
 * M1 模型清单：注册表全量 + 各模型凭据是否就绪 + 服务端默认。
 * Web 模型切换菜单的唯一数据源；baseUrl 展示但不接受前端覆盖（防 key 外泄）。
 */
app.get('/api/models', c => c.json({
  models: registry.list().map(m => ({
    ...m,
    hasKey: mock || apiKeyOf(m.apiKeyEnv ?? PROTOCOL_DEFAULTS[m.protocol].apiKeyEnv) !== null,
  })),
  default: { protocol: cfg.protocol, model: cfg.model },
  mock,
}));

/**
 * BYOK（#67）：Web 端安全录入 API Key。收 key 不收 baseUrl（M1 定案不回退）——
 * key 只进内存，只发往注册表内模型声明的端点；任何响应只回显尾 4 位，永不回显完整值。
 */
app.get('/api/keys', c => c.json({
  keys: registry.list().map(m => m.apiKeyEnv ?? PROTOCOL_DEFAULTS[m.protocol].apiKeyEnv)
    .filter((v, i, a) => a.indexOf(v) === i) // 注册表出现的 env 名去重
    .map(name => {
      const byok = byokKeys.get(name) ?? null;
      const env = process.env[name] ?? null;
      const value = byok ?? env;
      return {
        apiKeyEnv: name,
        source: byok !== null ? 'byok' as const : env !== null ? 'env' as const : 'none' as const,
        // 尾 4 位提示（业界惯例：可确认「是不是那把 key」又不暴露主体）
        hint: value !== null && value.length >= 8 ? `…${value.slice(-4)}` : null,
      };
    }),
  note: 'BYOK key 只存服务端内存，重启后需重新录入；环境变量来源不可在此清除',
}));

app.post('/api/keys', async c => {
  const body = await c.req.json().catch(() => null) as { apiKeyEnv?: unknown; value?: unknown } | null;
  const name = typeof body?.apiKeyEnv === 'string' ? body.apiKeyEnv : '';
  const value = typeof body?.value === 'string' ? body.value : '';
  if (!ENV_NAME.test(name)) return c.json({ error: `apiKeyEnv 必须是合法环境变量名（大写字母/数字/下划线），不是 key 本身` }, 400);
  if (!value.trim() || value.length < 8) return c.json({ error: 'value 必须是不少于 8 字符的 key 值' }, 400);
  byokKeys.set(name, value);
  registry.invalidate(); // 缓存实例持旧 key，必须重建
  console.log(`[byok] 已录入 ${name}（尾4位 ${value.slice(-4)}）——值不落盘不进日志`);
  return c.json({ ok: true, apiKeyEnv: name, hint: `…${value.slice(-4)}` });
});

app.delete('/api/keys/:name', c => {
  const name = c.req.param('name');
  if (!byokKeys.has(name)) {
    return c.json({ error: `${name} 不是 BYOK 录入的 key（环境变量来源请在服务端侧移除）` }, 404);
  }
  byokKeys.delete(name);
  registry.invalidate();
  console.log(`[byok] 已清除 ${name}`);
  return c.json({ ok: true });
});

/**
 * M7B 工作区清单：注册表白名单（id/name/path/default）。
 * 前端只能传这里的 id；任意路径一律 400——与模型端点同构的安全模型。
 */
app.get('/api/workspaces', c => c.json({
  workspaces: workspaces.map(w => ({ id: w.id, name: w.name, path: w.path, default: w.default })),
}));

/** 校验并应用会话级配置（建会话与 PATCH 共用）。返回错误信息或 null */
function applySessionConfig(s: Session, body: { protocol?: unknown; model?: unknown; reset?: unknown; archived?: unknown; [k: string]: unknown }): string | null {
  // 严格字段白名单：baseUrl 等只能来自服务端配置（防 key 外泄通道），越权字段显式 400 而非静默忽略
  for (const k of Object.keys(body)) {
    if (k !== 'protocol' && k !== 'model' && k !== 'reset' && k !== 'archived') {
      return `不支持的配置字段: ${k}（baseUrl 等只能由服务端配置；Web 仅可从注册表选择模型）`;
    }
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') return 'archived 必须是 boolean';
    s.archived = body.archived;
  }
  if (body.reset === true) { s.protocol = null; s.model = null; return null; }
  let protocol: SessionProtocol | null = null;
  if (body.protocol !== undefined && body.protocol !== null) {
    if (body.protocol !== 'anthropic' && body.protocol !== 'openai') return 'protocol 必须是 anthropic | openai';
    protocol = body.protocol;
  }
  let model: string | null = null;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string' || !body.model.trim()) return 'model 必须是非空字符串';
    const info = registry.find(body.model.trim());
    if (!info) return `未知模型 ${body.model}（不在注册表：内置 + ~/.water/config.json models[]）`;
    model = info.id;
    // 模型自带协议：以模型为准，避免「openai 协议配 glm 模型」的错配
    protocol = info.protocol;
  } else if (protocol) {
    // 只切协议：模型跟随该协议默认，除非当前模型本就属于新协议
    const cur = s.model ? registry.find(s.model) : undefined;
    if (!cur || cur.protocol !== protocol) model = PROTOCOL_DEFAULTS[protocol].model;
  }
  if (protocol) s.protocol = protocol;
  if (model !== null) s.model = model;
  return null;
}

/** 审批规则表：由工具风险级 + 默认策略派生，与内核 PermissionEngine 行为一致 */
app.get('/api/permissions', c => c.json({
  autoAllowLowRisk: true,
  rules: allTools.map(t => ({
    tool: t.spec.name,
    risk: t.risk,
    policy: t.risk === 'low' ? '自动放行' : '每次询问',
  })),
}));

app.get('/api/sessions', c => c.json({
  sessions: store.list(c.req.query('archived') === '1'),
}));

/** 插件清单：名称/版本/权限/注册物/加载错误；含配置式命令（M13） */
app.get('/api/plugins', c => c.json({
  plugins: plugins.plugins.map(p => ({
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description ?? '',
    permissions: p.manifest.permissions ?? [],
    tools: p.tools.map(t => t.spec.name),
    commands: p.commands.map(cd => `/${cd.name}`),
    dir: p.dir,
    error: p.error ?? null,
  })),
  configCommands: (fileCfg.commands ?? []).map(c => ({
    name: `/${c.name}`,
    ...(c.description ? { description: c.description } : {}),
  })),
  // M17/M22：配置式声明工具清单（prompt 型模板 / http 型出网声明）
  configTools: (fileCfg.tools ?? []).map(t => ({
    name: t.name,
    kind: t.kind ?? 'prompt',
    description: t.description,
    hasParameters: Boolean(t.parameters),
  })),
}));

/** 任务列表（最近 200 条） */
app.get('/api/tasks', c => c.json({ tasks: store.listTasks() }));

// ---- 工作区文件浏览 ----

interface FileNode { name: string; path: string; dir: boolean; children?: FileNode[] }

function resolveInCwd(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error('路径越出工作区');
  return abs;
}

async function buildTree(root: string, dir: string, depth: number): Promise<FileNode[]> {
  if (depth <= 0) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: FileNode[] = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'target') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      out.push({ name: e.name, path: rel, dir: true, children: await buildTree(root, full, depth - 1) });
    } else {
      out.push({ name: e.name, path: rel, dir: false });
    }
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

app.get('/api/files/tree', async c => {
  try {
    const ws = findWorkspace(c.req.query('workspaceId'));
    const tree = await buildTree(ws.path, ws.path, 4);
    return c.json({ root: ws.path, tree, workspaceId: ws.id });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.get('/api/files/content', async c => {
  const p = c.req.query('path');
  if (!p) return c.json({ error: '缺少 path 参数' }, 400);
  try {
    const ws = findWorkspace(c.req.query('workspaceId'));
    const abs = resolveInCwd(ws.path, p);
    const st = await fsp.stat(abs);
    if (st.size > 512 * 1024) return c.json({ error: '文件过大（>512KB），仅支持预览小文件' }, 413);
    const text = await fsp.readFile(abs, 'utf8');
    return c.json({ path: p, size: st.size, content: text });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
  }
});

/** 会话历史：Web 切换会话时水合渲染用 */
app.get('/api/sessions/:id/messages', c => {
  const s = store.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  return c.json({ title: s.title, messages: s.messages });
});

/**
 * M3 事件回放：返回当前运行中 seq 之后的事件（断线补帧 / 刷新接流）。
 * 缓冲在每条消息开始时重置，因此 since=0 即「本次运行的完整事件流」。
 */
app.get('/api/sessions/:id/events', c => {
  const s = store.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  s.notifyReconnect(); // M19：读取回放端点 = 客户端还活着（断开宽限期内重连的信号）
  const since = Number(c.req.query('since') ?? 0) || 0;
  return c.json({ events: s.eventsSince(since), busy: s.busy });
});

app.post('/api/sessions', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  // M7B：工作区绑定——创建时定死，只接受注册表内的 id（防目录逃逸）
  let wsId: string | null = null;
  if (body.workspaceId !== undefined && body.workspaceId !== null) {
    if (typeof body.workspaceId !== 'string' || !workspaces.some(w => w.id === body.workspaceId)) {
      return c.json({ error: `未知工作区 ${String(body.workspaceId)}（白名单：GET /api/workspaces）` }, 400);
    }
    wsId = body.workspaceId as string;
  }
  const { workspaceId: _strip, ...rest } = body ?? {};
  const s = store.create();
  if (wsId) s.workspaceId = wsId;
  const err = applySessionConfig(s, rest);
  if (err) { store.delete(s.id); return c.json({ error: err }, 400); }
  store.save(s);
  return c.json({ id: s.id, protocol: s.protocol, model: s.model, workspaceId: s.workspaceId }, 201);
});

/** M1：会话级模型/协议切换（运行时生效，无需重启进程；busy 中拒绝） */
app.patch('/api/sessions/:id/config', async c => {
  const s = store.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  if (s.busy) return c.json({ error: '会话忙：处理中不可切换模型' }, 409);
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: '请求体必须是合法 JSON' }, 400);
  const err = applySessionConfig(s, body);
  if (err) return c.json({ error: err }, 400);
  store.save(s);
  return c.json({ ok: true, protocol: s.protocol, model: s.model });
});

app.delete('/api/sessions/:id', c => {
  const s = store.get(c.req.param('id'));
  if (s?.busy) return c.json({ error: '会话忙，不能删除' }, 409);
  return store.delete(c.req.param('id'))
    ? c.json({ ok: true })
    : c.json({ error: 'session not found' }, 404);
});

app.post('/api/sessions/:id/approve', async c => {
  const s = store.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  let body: { callId?: string; decision?: ApprovalDecision };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求体必须是合法 JSON' }, 400);
  }
  const decision = body.decision;
  if (!body.callId || !decision || !['once', 'session', 'deny'].includes(decision)) {
    return c.json({ error: '需要 {callId, decision: once|session|deny}' }, 400);
  }
  return s.resolveApproval(body.callId, decision)
    ? c.json({ ok: true })
    : c.json({ error: '没有悬挂的该 callId 审批（可能已超时或已处理）' }, 404);
});

app.post('/api/sessions/:id/messages', async c => {
  const s = store.get(c.req.param('id'));
  if (!s) return c.json({ error: 'session not found' }, 404);
  if (s.archived) return c.json({ error: '会话已归档：历史可查看；如需继续对话请先取消归档' }, 400);

  const body = await c.req.json<{ text?: string }>().catch(() => null);
  if (!body?.text?.trim()) return c.json({ error: '需要合法 JSON 且 text 不能为空' }, 400);

  let text = body.text.trim();

  // 内置斜杠命令（M2）：本地处理，不进模型
  const builtinReply = runBuiltinCommand(text, s);
  if (builtinReply !== null) {
    s.messages.push({ role: 'user', parts: [{ type: 'text', text }] });
    if (s.title === '新会话') s.title = text.slice(0, 30);
    s.messages.push({ role: 'assistant', parts: [{ type: 'text', text: builtinReply }] });
    store.save(s);
    return streamSSE(c, async stream => {
      const send = (ev: Record<string, unknown>) => {
        const seq = s.recordEvent(ev);
        return stream.writeSSE({ id: String(seq), event: ev.type as string, data: JSON.stringify(ev) });
      };
      await send({ type: 'turn_start', turn: 1, model: s.model ?? cfg.model });
      await send({ type: 'text_delta', text: builtinReply });
      await send({ type: 'finish', reason: 'end' });
    });
  }

  // 斜杠命令展开：内置 > ESM 插件 > 配置式（M13 优先级约定）；模板替换 $ARGUMENTS
  const cmdMatch = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (cmdMatch) {
    const cmdName = cmdMatch[1]!;
    const cmdArgs = cmdMatch[2] ?? '';
    const cmd: { template: string } | undefined = plugins.commands.find(cd => cd.name === cmdName)
      ?? fileCfg.commands?.find(c => c.name === cmdName);
    if (cmd) text = cmd.template.replace(/\$ARGUMENTS/g, cmdArgs);
  }

  // M1：按「会话覆盖 + 服务端默认」解析本次运行的模型与 provider（失败快速返回，不污染历史）
  const rt = sessionRuntime(s);
  if ('error' in rt) return c.json({ error: rt.error }, 400);

  // M7B：会话绑定的工作区——SYSTEM（含其 AGENTS.md）与工具执行根都随工作区
  const ws = findWorkspace(s.workspaceId);
  const wsSystem = SYSTEM_BY_WS.get(ws.id)!.system;

  // M2：上下文预算（强制 env > 模型窗口 × 0.8）；M9：摘要压缩开关（mock 与显式关闭时禁用）
  const forced = Number(process.env.WATER_MAX_CONTEXT_TOKENS) || 0;
  const budget = forced > 0 ? forced
    : rt.contextWindow ? Math.floor(rt.contextWindow * 0.8)
    : undefined;
  const compactSummarize = !mock && process.env.WATER_COMPACT_SUMMARY !== '0';

  // M14 消息排队：深度上限 5（含执行中），超出 429；排队请求先收 queued 事件再等待闸门
  if (s.waiters >= 5) {
    return c.json({ error: '队列已满（5 条）：请稍候再发' }, 429);
  }
  const turn = s.enqueueTurn();

  return streamSSE(c, async stream => {
    // M19：安全发送——宽限期内客户端可能已断开，SSE 写失败不能中断运行（事件已进回放缓冲）
    const send = (frame: { id?: string; event: string; data: string }): Promise<void> =>
      stream.writeSSE(frame).catch(() => { /* 已断开：回放缓冲里仍有这份事件 */ });
    if (turn.position > 0) {
      // 瞬时状态事件：不进回放缓冲（不属于本次运行的事件序列）
      await send({ event: 'queued', data: JSON.stringify({ type: 'queued', position: turn.position }) });
    }
    await turn.wait(); // 等前一条完成（按到达顺序串行）

    // 排队期间客户端已断开：跳过执行，直接释放闸门
    if (c.req.raw.signal.aborted) {
      await send({ event: 'finish', data: JSON.stringify({ type: 'finish', reason: 'aborted' }) });
      turn.release();
      return;
    }

    // M16：全局并行闸门——会话级闸门获得后再取全局槽位；跨会话 FIFO 排队
    const slot = parallelGate.acquire();
    if (slot.queued) {
      await send({
        event: 'queued',
        data: JSON.stringify({ type: 'queued', position: slot.position, scope: 'global' }),
      });
    }
    await slot.ready;
    if (c.req.raw.signal.aborted || store.get(s.id) !== s) {
      // 全局排队期间断开/会话已被删除：同 M14 语义——跳过执行，释放两级闸门
      await send({ event: 'finish', data: JSON.stringify({ type: 'finish', reason: 'aborted' }) });
      slot.release();
      turn.release();
      return;
    }

    s.busy = true;
    s.messages.push({ role: 'user', parts: [{ type: 'text', text }] });
    if (s.title === '新会话') s.title = text.slice(0, 30);
    s.resetEventBuffer(); // M3：回放缓冲只覆盖本次运行

    // M19：断开宽限——SSE 断开不再立即中断；宽限期内重连（events 端点读取）可继续，
    // 超时才中断 Loop + 全拒（安全兜底不放松；WATER_APPROVAL_GRACE_MS=0 回到旧语义）
    const ac = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => {
      if (APPROVAL_GRACE_MS <= 0) {
        ac.abort();
        s.denyAllPending();
        return;
      }
      s.beginGrace(APPROVAL_GRACE_MS, () => {
        ac.abort();
        s.denyAllPending();
      });
    });
    // 审批桥：Loop 内发起审批时，先向客户端广播 approval_required，再等审批端点 resolve。
    // M15：子级审批（callId 含 `${task调用id}:` 命名空间前缀）包成 sub_event 嵌套帧，
    // 归入 task 工具卡的子代理过程区，并进回放缓冲（刷新接流后审批卡可重现，
    // 后续 tool_approved/tool_denied 帧会把状态收拢）；审批端点无需区分父子——
    // pending 按完整 callId 挂起，resolve 语义与主循环一致。
    const approve = (call: ToolUsePart) => {
      // M19：主/子审批帧统一进回放缓冲（此前主循环审批是瞬时事件——刷新即丢）；
      // 后续 tool_approved/tool_denied 帧会把回放出的审批卡收拢到终态。
      // M15：子级审批（callId 含命名空间前缀）包成 sub_event 嵌套帧，归入 task 工具卡。
      const sep = call.id.indexOf(':');
      const frame = sep > 0
        ? { type: 'sub_event', callId: call.id.slice(0, sep), ev: { type: 'approval_required', callId: call.id, call } }
        : { type: 'approval_required', callId: call.id, call };
      const seq = s.recordEvent(frame);
      void send({ id: String(seq), event: frame.type, data: JSON.stringify(frame) });
      return s.waitApproval(call);
    };

    // 任务记录：Loop 开始即建档（任务页可见「运行中」），结束时更新为终态并落库
    // id 带随机后缀：M16 会话间并行后同毫秒完成不再撞 tasks 主键（issue #43）
    const task: TaskRecord = {
      id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: s.id, title: s.title,
      startedAt: Date.now(), finishedAt: 0, status: 'running',
      steps: [], tokensIn: 0, tokensOut: 0,
    };
    store.beginTask(task);

    try {
      for await (const ev of agentLoop({
        provider: rt.provider, model: rt.model, system: wsSystem, messages: s.messages,
        ...(budget !== undefined ? { maxContextTokens: budget } : {}),
        ...(compactSummarize ? { compactSummarize: true } : {}),
        tools: allTools, permissions: s.permissions, hooks: plugins.hooks,
        toolCtx: { cwd: ws.path }, approve,
        maxTurns: 20, signal: ac.signal,
      })) {
        // 收集任务步骤
        if (ev.type === 'tool_result') {
          const step: TaskStep = {
            tool: ev.call.name,
            summary: JSON.stringify(ev.call.input).slice(0, 80),
            ok: !ev.isError, durationMs: ev.durationMs,
          };
          task.steps.push(step);
        } else if (ev.type === 'tool_denied') {
          task.steps.push({ tool: ev.call.name, summary: '', ok: null, durationMs: 0 });
        } else if (ev.type === 'usage') {
          task.tokensIn += ev.inputTokens; task.tokensOut += ev.outputTokens;
          s.tokensIn += ev.inputTokens; s.tokensOut += ev.outputTokens;
        } else if (ev.type === 'finish') {
          task.status = ev.reason === 'end' ? 'done'
            : ev.reason === 'error' ? 'error'
            : ev.reason === 'aborted' ? 'aborted' : 'max_turns';
        }
        // M3：帧 id = 事件 seq（断线后可经 /events?since= 补帧；M19 断开宽限期内照常入缓冲）
        const seq = s.recordEvent(ev);
        await send({ id: String(seq), event: ev.type, data: JSON.stringify(ev) });
      }
    } catch (e) {
      task.status = 'error';
      await send({
        event: 'error',
        data: JSON.stringify({ type: 'finish', reason: 'error', message: String(e) }),
      });
    } finally {
      task.finishedAt = Date.now();
      store.finishTask(task); // 终态落库
      s.busy = false;
      s.denyAllPending();
      s.cancelGrace(); // M19：运行结束清掉宽限定时器
      store.save(s); // 消息处理结束 → 落库
      turn.release(); // M14：放行下一条排队消息
      slot.release(); // M16：释放全局槽位（转交给跨会话等待者）
    }
  });
});

const port = Number(process.env.WATER_PORT ?? 3210);

// ---- 生产形态：托管 Web 构建产物（单进程交付；API 路由注册在前，优先级更高） ----
const webDist = process.env.WATER_WEB_DIST ?? path.resolve(cfg.cwd, 'apps/web/dist');
if (existsSync(webDist)) {
  app.use('/*', serveStatic({ root: webDist }));
  // SPA fallback：非 API 路径一律回 index.html，前端路由自己接管
  app.get('*', serveStatic({ path: path.join(webDist, 'index.html') }));
}

async function main(): Promise<void> {
  // 插件加载（启动时一次；开发期重启即重载）
  plugins = await loadPlugins(cfg.cwd);
  allTools = [...builtinTools, ...configToolWrappers, ...plugins.tools];

  serve({ fetch: app.fetch, port }, info => {
    console.log(`water server · http://127.0.0.1:${info.port} · ${mock ? 'MOCK 模式' : `${cfg.model} via ${cfg.protocol}`} · 工作区 ${cfg.cwd}`);
    if (existsSync(webDist)) console.log(`web 静态托管: ${webDist}`);
  });
}

main().catch(e => {
  console.error('server 启动失败:', e);
  process.exit(1);
});
