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
  agentLoop, builtinTools, compactMessages, createProvider, estimateMessagesTokens, loadPlugins,
  loadFileConfig, MockProvider, ProviderRegistry, resolveConfig, BUILTIN_MODELS, mergeModels,
  PROTOCOL_DEFAULTS, PROTOCOL_LABEL,
  type PluginRegistry, type Provider, type ToolUsePart,
} from '@water/core';
import { SessionStore, type ApprovalDecision, type Session, type SessionProtocol, type TaskRecord, type TaskStep } from './session.js';
import { SessionPersistence } from './persistence.js';

const cfg = resolveConfig({});
const mock = process.env.WATER_MOCK === '1';
if (!mock && !cfg.apiKey) {
  console.error(`❌ 缺少凭据 ${cfg.apiKeyEnv}。用 start-secure 启动，或 WATER_MOCK=1 离线模式。`);
  process.exit(1);
}

/** 凭据读取通道：start-secure 注入的环境变量（名字来自注册表，值永不出服务端） */
const apiKeyOf = (envName: string): string | null => process.env[envName] ?? null;

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

// ---- SYSTEM prompt（M2）：env WATER_SYSTEM > config.json systemPrompt > 内置默认 ----
// 工作区根有 AGENTS.md 则自动拼接为「项目上下文」（重启生效；凭据红线与模型无关，不受限）
const DEFAULT_SYSTEM = [
  '你是 Water，一个工作在当前代码仓库里的 AI 编程助手。',
  '可用工具：read/write/edit/grep/glob/shell。优先小步快跑，改动前先读代码。',
  '回答使用中文，简洁、直接、技术导向。',
].join('\n');
const SYSTEM_BASE = process.env.WATER_SYSTEM ?? fileCfg.systemPrompt ?? DEFAULT_SYSTEM;
const agentsPath = path.join(cfg.cwd, 'AGENTS.md');
const agentsMd = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8').slice(0, 8000) : null;
const SYSTEM = agentsMd
  ? `${SYSTEM_BASE}\n\n# 项目上下文（工作区 AGENTS.md）\n${agentsMd}`
  : SYSTEM_BASE;

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
    case 'system':
      return `当前生效 SYSTEM（${SYSTEM.length} 字符${agentsMd ? '，含工作区 AGENTS.md' : ''}，前 600 字预览）：\n${SYSTEM.slice(0, 600)}${SYSTEM.length > 600 ? '\n…' : ''}`;
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
  if (!cfg.apiKey) return { error: `缺少凭据 ${cfg.apiKeyEnv}` };
  return { protocol: cfg.protocol, model: cfg.model, provider: createProvider({ protocol: cfg.protocol, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey }) };
}

const store = new SessionStore(new SessionPersistence(cfg.cwd));
const app = new Hono();

// 插件注册表在 main() 里异步加载（避免顶层 await，兼容 CJS/SEA 打包）
let plugins: PluginRegistry = { plugins: [], tools: [], commands: [], hooks: [] };
let allTools = [...builtinTools];

app.use('/api/*', cors());

app.get('/api/config', c => c.json({
  protocol: mock ? 'mock' : cfg.protocol,
  baseUrl: mock ? '(mock)' : cfg.baseUrl,
  model: cfg.model,
  workspace: cfg.cwd,
  version: '0.1.0',
  // 只暴露「有没有」，永不暴露 key 本身
  hasKey: mock || Boolean(cfg.apiKey),
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

/** 校验并应用会话级配置（建会话与 PATCH 共用）。返回错误信息或 null */
function applySessionConfig(s: Session, body: { protocol?: unknown; model?: unknown; reset?: unknown; [k: string]: unknown }): string | null {
  // 严格字段白名单：baseUrl 等只能来自服务端配置（防 key 外泄通道），越权字段显式 400 而非静默忽略
  for (const k of Object.keys(body)) {
    if (k !== 'protocol' && k !== 'model' && k !== 'reset') {
      return `不支持的配置字段: ${k}（baseUrl 等只能由服务端配置；Web 仅可从注册表选择模型）`;
    }
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

app.get('/api/sessions', c => c.json({ sessions: store.list() }));

/** 插件清单：名称/版本/权限/注册物/加载错误 */
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
}));

/** 任务列表（最近 200 条） */
app.get('/api/tasks', c => c.json({ tasks: store.listTasks() }));

// ---- 工作区文件浏览 ----

interface FileNode { name: string; path: string; dir: boolean; children?: FileNode[] }

function resolveInCwd(p: string): string {
  const abs = path.resolve(cfg.cwd, p);
  const root = path.resolve(cfg.cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径越出工作区');
  return abs;
}

async function buildTree(dir: string, depth: number): Promise<FileNode[]> {
  if (depth <= 0) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: FileNode[] = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'target') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(cfg.cwd, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      out.push({ name: e.name, path: rel, dir: true, children: await buildTree(full, depth - 1) });
    } else {
      out.push({ name: e.name, path: rel, dir: false });
    }
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

app.get('/api/files/tree', async c => {
  try {
    const tree = await buildTree(cfg.cwd, 4);
    return c.json({ root: cfg.cwd, tree });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

app.get('/api/files/content', async c => {
  const p = c.req.query('path');
  if (!p) return c.json({ error: '缺少 path 参数' }, 400);
  try {
    const abs = resolveInCwd(p);
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

app.post('/api/sessions', async c => {
  const body = await c.req.json<{ protocol?: unknown; model?: unknown }>().catch(() => ({}));
  const s = store.create();
  const err = applySessionConfig(s, body ?? {});
  if (err) { store.delete(s.id); return c.json({ error: err }, 400); }
  store.save(s);
  return c.json({ id: s.id, protocol: s.protocol, model: s.model }, 201);
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
  if (s.busy) return c.json({ error: '会话忙：上一条消息还在处理' }, 409);

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
      await stream.writeSSE({ event: 'turn_start', data: JSON.stringify({ type: 'turn_start', turn: 1, model: s.model ?? cfg.model }) });
      await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ type: 'text_delta', text: builtinReply }) });
      await stream.writeSSE({ event: 'finish', data: JSON.stringify({ type: 'finish', reason: 'end' }) });
    });
  }

  // 斜杠命令展开：/review src/x.ts → 模板替换 $ARGUMENTS
  const cmdMatch = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (cmdMatch) {
    const cmd = plugins.commands.find(cd => cd.name === cmdMatch[1]);
    if (cmd) text = cmd.template.replace(/\$ARGUMENTS/g, cmdMatch[2] ?? '');
  }

  // M1：按「会话覆盖 + 服务端默认」解析本次运行的模型与 provider（失败快速返回，不污染历史）
  const rt = sessionRuntime(s);
  if ('error' in rt) return c.json({ error: rt.error }, 400);

  // M2：上下文预算（强制 env > 模型窗口 × 0.8）
  const forced = Number(process.env.WATER_MAX_CONTEXT_TOKENS) || 0;
  const budget = forced > 0 ? forced
    : rt.contextWindow ? Math.floor(rt.contextWindow * 0.8)
    : undefined;

  s.busy = true;
  s.messages.push({ role: 'user', parts: [{ type: 'text', text }] });
  if (s.title === '新会话') s.title = body.text.trim().slice(0, 30);

  // 请求中断 → 中断 Loop + 悬挂审批全拒
  const ac = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => {
    ac.abort();
    s.denyAllPending();
  });

  return streamSSE(c, async stream => {
    // 审批桥：Loop 内发起审批时，先向客户端广播 approval_required，再等审批端点 resolve
    const approve = (call: ToolUsePart) => {
      void stream.writeSSE({
        event: 'approval_required',
        data: JSON.stringify({ type: 'approval_required', callId: call.id, call }),
      });
      return s.waitApproval(call);
    };

    // 任务记录：Loop 开始即建档（任务页可见「运行中」），结束时更新为终态并落库
    const task: TaskRecord = {
      id: `t_${Date.now().toString(36)}`,
      sessionId: s.id, title: s.title,
      startedAt: Date.now(), finishedAt: 0, status: 'running',
      steps: [], tokensIn: 0, tokensOut: 0,
    };
    store.beginTask(task);

    try {
      for await (const ev of agentLoop({
        provider: rt.provider, model: rt.model, system: SYSTEM, messages: s.messages,
        ...(budget !== undefined ? { maxContextTokens: budget } : {}),
        tools: allTools, permissions: s.permissions, hooks: plugins.hooks,
        toolCtx: { cwd: cfg.cwd }, approve,
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
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    } catch (e) {
      task.status = 'error';
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ type: 'finish', reason: 'error', message: String(e) }),
      });
    } finally {
      task.finishedAt = Date.now();
      store.finishTask(task); // 终态落库
      s.busy = false;
      s.denyAllPending();
      store.save(s); // 消息处理结束 → 落库
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
  allTools = [...builtinTools, ...plugins.tools];

  serve({ fetch: app.fetch, port }, info => {
    console.log(`water server · http://127.0.0.1:${info.port} · ${mock ? 'MOCK 模式' : `${cfg.model} via ${cfg.protocol}`} · 工作区 ${cfg.cwd}`);
    if (existsSync(webDist)) console.log(`web 静态托管: ${webDist}`);
  });
}

main().catch(e => {
  console.error('server 启动失败:', e);
  process.exit(1);
});
