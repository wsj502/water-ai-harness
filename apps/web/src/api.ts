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
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  turns: number;
  busy: boolean;
  pendingApprovals: number;
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
  status: 'done' | 'error' | 'aborted' | 'max_turns';
  steps: TaskStep[];
  tokensIn: number;
  tokensOut: number;
}

export interface FileNode {
  name: string;
  path: string;
  dir: boolean;
  children?: FileNode[];
}

export const api = {
  config: () => fetch(`${BASE}/api/config`).then(r => json<ServerConfig>(r)),

  listSessions: () =>
    fetch(`${BASE}/api/sessions`).then(r => json<{ sessions: SessionMeta[] }>(r)).then(j => j.sessions),

  listPlugins: () =>
    fetch(`${BASE}/api/plugins`).then(r => json<{ plugins: PluginInfo[] }>(r)).then(j => j.plugins),

  listTasks: () =>
    fetch(`${BASE}/api/tasks`).then(r => json<{ tasks: TaskRecord[] }>(r)).then(j => j.tasks),

  fileTree: () =>
    fetch(`${BASE}/api/files/tree`).then(r => json<{ root: string; tree: FileNode[] }>(r)),

  fileContent: (path: string) =>
    fetch(`${BASE}/api/files/content?path=${encodeURIComponent(path)}`)
      .then(r => json<{ path: string; size: number; content: string }>(r)),

  createSession: () =>
    fetch(`${BASE}/api/sessions`, { method: 'POST' }).then(r => json<{ id: string }>(r)).then(j => j.id),

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
