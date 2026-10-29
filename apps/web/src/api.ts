/**
 * Water Server API 客户端。
 * 会话消息走 SSE：fetch + ReadableStream 手动解析帧（POST 流不能用 EventSource）。
 *
 * 基地址：浏览器开发/生产（server 静态托管）走同源相对路径；
 * Tauri 桌面端 origin 是 tauri://localhost，需显式指向 sidecar 的 127.0.0.1:3210。
 */
import type { LoopEvent, WMessage } from '@water/core';

const BASE: string =
  typeof window !== 'undefined' && '__TAURI__' in window ? 'http://127.0.0.1:3210' : '';

export interface ServerConfig {
  protocol: string;
  baseUrl: string;
  model: string;
  workspace: string;
  version: string;
  hasKey?: boolean;
  apiKeyEnv?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  busy: boolean;
  pendingApprovals: number;
  /** 会话级覆盖（null/缺省 = 跟随服务端默认） */
  protocol?: string | null;
  model?: string | null;
}

/** 模型注册表条目（GET /api/models） */
export interface ModelInfo {
  id: string;
  protocol: 'anthropic' | 'openai';
  label: string;
  vendor: string;
  contextWindow?: number;
  thinking?: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** 该模型凭据是否就绪（服务端视角；false 时选它会在发消息时报错） */
  hasKey?: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
  default: { protocol: string; model: string };
  mock: boolean;
}

/** 服务端在 Loop 之外补发的审批请求事件 */
export interface ApprovalRequiredEvent {
  type: 'approval_required';
  callId: string;
  call: { id: string; name: string; input: Record<string, unknown> };
}

export type ServerEvent = LoopEvent | ApprovalRequiredEvent;

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

export interface PluginInfo {
  name: string;
  version: string;
  description: string;
  permissions: string[];
  tools: string[];
  commands: string[];
  dir: string;
  error: string | null;
}

export interface TaskStep {
  tool: string;
  summary: string;
  ok: boolean | null;
  durationMs: number;
}

export interface TaskRecord {
  id: string;
  sessionId: string;
  title: string;
  startedAt: number;
  finishedAt: number;
  status: 'running' | 'done' | 'error' | 'aborted' | 'max_turns';
  steps: TaskStep[];
  tokensIn: number;
  tokensOut: number;
}

/** 审批规则表行（GET /api/permissions） */
export interface PermissionRuleInfo {
  tool: string;
  risk: 'low' | 'medium' | 'high';
  policy: string;
}

export interface FileNode {
  name: string;
  path: string;
  dir: boolean;
  children?: FileNode[];
}

export const api = {
  config: () => fetch(`${BASE}/api/config`).then(r => json<ServerConfig>(r)),

  models: () => fetch(`${BASE}/api/models`).then(r => json<ModelsResponse>(r)),

  listSessions: () =>
    fetch(`${BASE}/api/sessions`).then(r => json<{ sessions: SessionMeta[] }>(r)).then(j => j.sessions),

  listPlugins: () =>
    fetch(`${BASE}/api/plugins`).then(r => json<{ plugins: PluginInfo[] }>(r)).then(j => j.plugins),

  listTasks: () =>
    fetch(`${BASE}/api/tasks`).then(r => json<{ tasks: TaskRecord[] }>(r)).then(j => j.tasks),

  permissions: () =>
    fetch(`${BASE}/api/permissions`).then(r => json<{ autoAllowLowRisk: boolean; rules: PermissionRuleInfo[] }>(r)),

  fileTree: () =>
    fetch(`${BASE}/api/files/tree`).then(r => json<{ root: string; tree: FileNode[] }>(r)),

  fileContent: (path: string) =>
    fetch(`${BASE}/api/files/content?path=${encodeURIComponent(path)}`)
      .then(r => json<{ path: string; size: number; content: string }>(r)),

  createSession: (init?: { model?: string; protocol?: string }) =>
    fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init ?? {}),
    }).then(r => json<{ id: string; protocol: string | null; model: string | null }>(r)),

  /** 会话级模型/协议切换（M1）；reset:true 回到服务端默认 */
  setSessionConfig: (sid: string, cfg: { model?: string; protocol?: string; reset?: boolean }) =>
    fetch(`${BASE}/api/sessions/${sid}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    }).then(r => json<{ ok: boolean; protocol: string | null; model: string | null }>(r)),

  history: (sid: string) =>
    fetch(`${BASE}/api/sessions/${sid}/messages`).then(r => json<{ title: string; messages: WMessage[] }>(r)),

  approve: (sid: string, callId: string, decision: 'once' | 'session' | 'deny') =>
    fetch(`${BASE}/api/sessions/${sid}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, decision }),
    }).then(r => json<{ ok: boolean }>(r)),

  /** 发送消息并消费 SSE 事件流 */
  async streamMessage(sid: string, text: string, onEvent: (ev: ServerEvent) => void, signal?: AbortSignal): Promise<void> {
    const resp = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: signal ?? null,
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = frame.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).replace(/^ /, ''));
        if (dataLines.length === 0) continue;
        try {
          onEvent(JSON.parse(dataLines.join('\n')) as ServerEvent);
        } catch { /* 跳过坏帧 */ }
      }
    }
  },
};
