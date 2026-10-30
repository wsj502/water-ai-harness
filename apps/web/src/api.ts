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
  /** M16：跨会话并发上限（WATER_MAX_PARALLEL_SESSIONS） */
  maxParallelSessions?: number;
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
  /** M14：排队中的消息数（不含正在执行的） */
  queued?: number;
  /** 会话级覆盖（null/缺省 = 跟随服务端默认） */
  protocol?: string | null;
  model?: string | null;
  /** M7A：归档状态 */
  archived?: boolean;
  /** M7B：绑定工作区（null/缺省 = default） */
  workspaceId?: string | null;
}

/** 工作区注册表条目（GET /api/workspaces） */
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  default: boolean;
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

/** M14：排队状态事件（瞬时，不进回放缓冲）。M16：scope=global 表示跨会话排队（全局并发已满） */
export interface QueuedEvent {
  type: 'queued';
  position: number;
  scope?: 'session' | 'global';
}

/** M15：子级审批请求——嵌套在 sub_event 里（callId 为 `${task调用id}:${子id}` 命名空间） */
export interface SubApprovalEvent {
  type: 'sub_event';
  callId: string;
  ev: ApprovalRequiredEvent;
}

export type ServerEvent = LoopEvent | ApprovalRequiredEvent | QueuedEvent | SubApprovalEvent;

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

  workspaces: () =>
    fetch(`${BASE}/api/workspaces`).then(r => json<{ workspaces: WorkspaceInfo[] }>(r)).then(j => j.workspaces),

  listSessions: (archived?: boolean) =>
    fetch(`${BASE}/api/sessions${archived ? '?archived=1' : ''}`)
      .then(r => json<{ sessions: SessionMeta[] }>(r)).then(j => j.sessions),

  listPlugins: () =>
    fetch(`${BASE}/api/plugins`).then(r => json<{ plugins: PluginInfo[] }>(r)).then(j => j.plugins),

  /** M13：配置式命令清单（~/.water/config.json commands[]） */
  configCommands: () =>
    fetch(`${BASE}/api/plugins`).then(r => json<{ configCommands: Array<{ name: string; description?: string }> }>(r))
      .then(j => j.configCommands ?? []),

  /** M17：配置式声明工具清单（~/.water/config.json tools[]，prompt 型） */
  configTools: () =>
    fetch(`${BASE}/api/plugins`).then(r => json<{ configTools: Array<{ name: string; description: string; hasParameters: boolean }> }>(r))
      .then(j => j.configTools ?? []),

  listTasks: () =>
    fetch(`${BASE}/api/tasks`).then(r => json<{ tasks: TaskRecord[] }>(r)).then(j => j.tasks),

  permissions: () =>
    fetch(`${BASE}/api/permissions`).then(r => json<{ autoAllowLowRisk: boolean; rules: PermissionRuleInfo[] }>(r)),

  fileTree: (workspaceId?: string) =>
    fetch(`${BASE}/api/files/tree${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`)
      .then(r => json<{ root: string; tree: FileNode[]; workspaceId?: string }>(r)),

  fileContent: (path: string, workspaceId?: string) =>
    fetch(`${BASE}/api/files/content?path=${encodeURIComponent(path)}${workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : ''}`)
      .then(r => json<{ path: string; size: number; content: string }>(r)),

  createSession: (init?: { model?: string; protocol?: string; workspaceId?: string }) =>
    fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init ?? {}),
    }).then(r => json<{ id: string; protocol: string | null; model: string | null; workspaceId: string | null }>(r)),

  /** 会话级模型/协议切换（M1）；reset:true 回到服务端默认；archived 归档（M7A） */
  setSessionConfig: (sid: string, cfg: { model?: string; protocol?: string; reset?: boolean; archived?: boolean }) =>
    fetch(`${BASE}/api/sessions/${sid}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    }).then(r => json<{ ok: boolean; protocol: string | null; model: string | null }>(r)),

  /** 删除会话（busy 中服务端 409） */
  deleteSession: (sid: string) =>
    fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).then(r => json<{ ok: boolean }>(r)),

  history: (sid: string) =>
    fetch(`${BASE}/api/sessions/${sid}/messages`).then(r => json<{ title: string; messages: WMessage[] }>(r)),

  approve: (sid: string, callId: string, decision: 'once' | 'session' | 'deny') =>
    fetch(`${BASE}/api/sessions/${sid}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, decision }),
    }).then(r => json<{ ok: boolean }>(r)),

  /** 发送消息并消费 SSE 事件流（onEvent 第二参为帧 id = 事件 seq，断线补帧游标） */
  async streamMessage(sid: string, text: string, onEvent: (ev: ServerEvent, id?: number) => void, signal?: AbortSignal): Promise<void> {
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
        const idLine = frame.split('\n').find(l => l.startsWith('id:'));
        const frameId = idLine ? Number(idLine.slice(3).trim()) : undefined;
        const dataLines = frame.split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).replace(/^ /, ''));
        if (dataLines.length === 0) continue;
        try {
          onEvent(JSON.parse(dataLines.join('\n')) as ServerEvent, Number.isFinite(frameId) ? frameId : undefined);
        } catch { /* 跳过坏帧 */ }
      }
    }
  },

  /** M3：事件回放（断线补帧 / busy 会话接流）。返回事件与 busy 状态 */
  eventsSince: (sid: string, since: number) =>
    fetch(`${BASE}/api/sessions/${sid}/events?since=${since}`)
      .then(r => json<{ events: Array<{ seq: number; ev: ServerEvent }>; busy: boolean }>(r)),
};
