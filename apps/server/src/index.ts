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
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  agentLoop, builtinTools, createProvider, MockProvider,
  resolveConfig, type Provider, type ToolUsePart,
} from '@water/core';
import { SessionStore, type ApprovalDecision } from './session.js';

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

const store = new SessionStore();
const app = new Hono();

app.use('/api/*', cors());

app.get('/api/config', c => c.json({
  protocol: mock ? 'mock' : cfg.protocol,
  baseUrl: mock ? '(mock)' : cfg.baseUrl,
  model: cfg.model,
  workspace: cfg.cwd,
  version: '0.1.0',
}));

app.get('/api/sessions', c => c.json({ sessions: store.list() }));

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

  s.busy = true;
  s.messages.push({ role: 'user', parts: [{ type: 'text', text: body.text }] });
  if (s.title === '新会话') s.title = body.text.slice(0, 30);

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
    try {
      for await (const ev of agentLoop({
        provider, model: cfg.model, system: SYSTEM, messages: s.messages,
        tools: builtinTools, permissions: s.permissions,
        toolCtx: { cwd: cfg.cwd }, approve,
        maxTurns: 20, signal: ac.signal,
      })) {
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
      }
    } catch (e) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ type: 'finish', reason: 'error', message: String(e) }),
      });
    } finally {
      s.busy = false;
      s.denyAllPending();
    }
  });
});

const port = Number(process.env.WATER_PORT ?? 3210);
serve({ fetch: app.fetch, port }, info => {
  console.log(`water server · http://127.0.0.1:${info.port} · ${mock ? 'MOCK 模式' : `${cfg.model} via ${cfg.protocol}`} · 工作区 ${cfg.cwd}`);
});
