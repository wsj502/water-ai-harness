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
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  agentLoop, builtinTools, createProvider, loadPlugins, MockProvider,
  resolveConfig, type PluginRegistry, type Provider, type ToolUsePart,
} from '@water/core';
import { SessionStore, type ApprovalDecision, type TaskRecord, type TaskStep } from './session.js';
import { SessionPersistence } from './persistence.js';

const cfg = resolveConfig({});
const mock = process.env.WATER_MOCK === '1';
if (!mock && !cfg.apiKey) {
  console.error(`❌ 缺少凭据 ${cfg.apiKeyEnv}。用 start-secure 启动，或 WATER_MOCK=1 离线模式。`);
  process.exit(1);
}

const provider: Provider = mock
  ? new MockProvider()
  : createProvider({ protocol: cfg.protocol, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey! });

const SYSTEM = [
  '你是 Water，一个工作在当前代码仓库里的 AI 编程助手。',
  '可用工具：read/write/edit/grep/glob/shell。优先小步快跑，改动前先读代码。',
  '回答使用中文，简洁、直接、技术导向。',
].join('\n');

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

app.post('/api/sessions', c => {
  const s = store.create();
  return c.json({ id: s.id }, 201);
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

  // 斜杠命令展开：/review src/x.ts → 模板替换 $ARGUMENTS
  const cmdMatch = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (cmdMatch) {
    const cmd = plugins.commands.find(cd => cd.name === cmdMatch[1]);
    if (cmd) text = cmd.template.replace(/\$ARGUMENTS/g, cmdMatch[2] ?? '');
  }

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

    // 任务记录：收集这次运行的步骤与 token
    const task: TaskRecord = {
      id: `t_${Date.now().toString(36)}`,
      sessionId: s.id, title: s.title,
      startedAt: Date.now(), finishedAt: 0, status: 'done',
      steps: [], tokensIn: 0, tokensOut: 0,
    };

    try {
      for await (const ev of agentLoop({
        provider, model: cfg.model, system: SYSTEM, messages: s.messages,
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
      store.addTask(task);
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
