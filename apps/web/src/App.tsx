import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ModelInfo, type ServerConfig, type SessionMeta } from './api';
import { applyEvent, hydrateBlocks, type UiBlock } from './state/blocks';
import { PluginsView } from './views/PluginsView';
import { SettingsView } from './views/SettingsView';
import { TasksView } from './views/TasksView';
import { WorkspaceView } from './views/WorkspaceView';

type View = 'chat' | 'tasks' | 'plugins' | 'workspace' | 'settings';

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export default function App() {
  const [view, setView] = useState<View>('chat');
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [mockMode, setMockMode] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 最近一次 usage 事件：inputTokens ≈ 当前上下文占用（composer 计量的真实数据源） */
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  const [pluginCount, setPluginCount] = useState(0);
  /** 工作区「在会话中引用」注入 composer 的草稿（nonce 驱动 effect） */
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
  /** 未激活会话时选的模型：作为下个新会话的初始配置（M1） */
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(e => setError(String(e)));
    api.models().then(m => { setModels(m.models); setMockMode(m.mock); }).catch(() => {});
    api.listSessions().then(setSessions).catch(() => {});
    api.listPlugins().then(ps => setPluginCount(ps.filter(p => !p.error).length)).catch(() => {});
  }, []);

  // 自动滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks]);

  const openSession = useCallback(async (id: string) => {
    setActiveId(id);
    setError(null);
    setUsage(null);
    setPendingModel(null);
    try {
      const h = await api.history(id);
      setBlocks(hydrateBlocks(h.messages));
    } catch (e) {
      setBlocks([]);
      setError(String(e));
    }
  }, []);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      let sid = activeId;
      if (!sid) {
        const created = await api.createSession(pendingModel ? { model: pendingModel } : undefined);
        sid = created.id;
        setActiveId(sid);
        setPendingModel(null);
      }
      setBlocks(bs => [...bs, { kind: 'user', text, ts: Date.now() }]);
      const ac = new AbortController();
      abortRef.current = ac;
      await api.streamMessage(sid, text, ev => {
        if (ev.type === 'usage') setUsage({ input: ev.inputTokens, output: ev.outputTokens });
        setBlocks(bs => applyEvent(bs, ev));
      }, ac.signal);
      api.listSessions().then(setSessions).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [activeId, busy, pendingModel]);

  const newSession = useCallback(() => {
    abortRef.current?.abort();
    setActiveId(null);
    setBlocks([]);
    setUsage(null);
  }, []);

  /** 选中模型：有激活会话 → PATCH 会话配置；无 → 记为下个新会话的初始配置（M1） */
  const pickModel = useCallback(async (modelId: string | null) => {
    if (activeId) {
      try {
        await api.setSessionConfig(activeId, modelId ? { model: modelId } : { reset: true });
        const list = await api.listSessions();
        setSessions(list);
      } catch (e) { setError(String(e)); }
    } else {
      setPendingModel(modelId);
    }
  }, [activeId]);

  /** 工作区文件引用：注入 composer 并切回会话页 */
  const injectRef = useCallback((text: string) => {
    setPrefill({ text, nonce: Date.now() });
    setView('chat');
  }, []);

  // 第一个等待审批的工具块（键盘审批的目标）
  const waitingCall = blocks.find(b => b.kind === 'tool' && b.status === 'waiting');
  const waitingCallId = waitingCall?.kind === 'tool' ? waitingCall.call.id : null;

  // 全局键盘：Esc 中断/拒绝；Enter/A 审批（输入框聚焦时仅 Esc 生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      const typing = tag === 'textarea' || tag === 'input' || tag === 'select';
      if (e.key === 'Escape') {
        if (waitingCallId && activeId) {
          void api.approve(activeId, waitingCallId, 'deny').catch(() => {});
        } else if (busy) {
          abortRef.current?.abort();
        }
        return;
      }
      if (typing || !waitingCallId || !activeId) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void api.approve(activeId, waitingCallId, 'once').catch(() => {});
      } else if (e.key === 'a' || e.key === 'A') {
        void api.approve(activeId, waitingCallId, 'session').catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [waitingCallId, activeId, busy]);

  const activeTitle = sessions.find(s => s.id === activeId)?.title ?? null;
  const activeMeta = sessions.find(s => s.id === activeId) ?? null;
  /** 生效模型/协议：会话覆盖 > 未建会话时的预选 > 服务端默认 */
  const effModel = activeMeta?.model ?? pendingModel ?? config?.model ?? '';
  const effProtocol = activeMeta?.protocol ?? (pendingModel ? models.find(m => m.id === pendingModel)?.protocol : undefined) ?? config?.protocol ?? '';
  const sessionOverridden = activeMeta != null && (activeMeta.model != null || activeMeta.protocol != null);

  return (
    <div className="app">
      <Topbar config={config} sessionTitle={view === 'chat' ? activeTitle : null} view={view}
        models={models} mockMode={mockMode}
        current={{ model: effModel, protocol: effProtocol }}
        showDefault={sessionOverridden} disabled={busy} onPick={pickModel} />
      <Sidebar sessions={sessions} activeId={activeId} view={view} config={config}
        onOpen={openSession} onNew={newSession} onNav={setView} />
      {view === 'chat' && (
      <main className="main">
        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-col">
            {blocks.length === 0 && (
              <div style={{ color: 'var(--text-2)', textAlign: 'center', marginTop: 80 }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>💧</div>
                <div>向 Water 描述你的任务</div>
                <div style={{ fontSize: 12, marginTop: 6 }}>read / write / edit / grep / glob / shell 工具已就绪</div>
              </div>
            )}
            {blocks.map((b, i) => (
              <Block key={i} block={b} sessionId={activeId} model={effModel}
                streaming={busy && i === blocks.length - 1} />
            ))}
            {error && <div className="approval"><div className="head"><span className="warn">✕</span><span>{error}</span></div></div>}
            {busy && <div style={{ color: 'var(--text-2)', fontSize: 12 }}>生成中…（Esc 中断）</div>}
          </div>
        </div>
        <Composer onSend={send} busy={busy} config={config} usage={usage} model={effModel}
          pluginCount={pluginCount} onNavPlugins={() => setView('plugins')} prefill={prefill} />
      </main>
      )}
      {view === 'plugins' && <PluginsView />}
      {view === 'tasks' && <TasksView />}
      {view === 'workspace' && <WorkspaceView onInject={injectRef} />}
      {view === 'settings' && <SettingsView />}
      <footer className="statusbar">
        <span className="item"><span className="ok">●</span> provider: {config?.protocol ?? '…'}</span>
        <span className="item">{config?.baseUrl ?? ''}</span>
        {pluginCount > 0 && <span className="item">⬡ 插件 {pluginCount} 个已启用</span>}
        <span className="spacer"></span>
        <span className="item">workspace: {config?.workspace ?? ''}</span>
        <span className="item">water v{config?.version ?? ''}</span>
      </footer>
    </div>
  );
}

const VIEW_CRUMB: Record<View, string> = {
  chat: '会话', tasks: '任务', plugins: '插件', workspace: '工作区', settings: '设置',
};

function Topbar({ config, sessionTitle, view, models, mockMode, current, showDefault, disabled, onPick }: {
  config: ServerConfig | null;
  sessionTitle: string | null;
  view: View;
  models: ModelInfo[];
  mockMode: boolean;
  current: { model: string; protocol: string };
  showDefault: boolean;
  disabled: boolean;
  onPick: (modelId: string | null) => void;
}) {
  return (
    <header className="topbar">
      <span className="crumb">{VIEW_CRUMB[view]}{sessionTitle ? <> / <b>{sessionTitle}</b></> : null}</span>
      <span className="spacer"></span>
      <ModelPill models={models} mockMode={mockMode} current={current}
        showDefault={showDefault} disabled={disabled} onPick={onPick} />
    </header>
  );
}

const PROTOCOL_LABEL: Record<'anthropic' | 'openai', string> = {
  anthropic: 'Anthropic Messages',
  openai: 'OpenAI 兼容',
};

function fmtCtx(n?: number): string {
  return n == null ? '' : n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`;
}

/** 模型切换器（M1）：P0 原生的纯 CSS 下拉（:focus-within），接 /api/models 真数据 */
function ModelPill({ models, mockMode, current, showDefault, disabled, onPick }: {
  models: ModelInfo[];
  mockMode: boolean;
  current: { model: string; protocol: string };
  showDefault: boolean;
  disabled: boolean;
  onPick: (modelId: string | null) => void;
}) {
  const groups: Array<{ protocol: string; label: string; items: ModelInfo[] }> = [];
  for (const p of ['anthropic', 'openai'] as const) {
    const items = models.filter(m => m.protocol === p);
    if (items.length) groups.push({ protocol: p, label: PROTOCOL_LABEL[p], items });
  }
  const pick = (id: string | null) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onPick(id);
    // 释放焦点收起菜单（纯 CSS :focus-within 方案的收起手段）
    const pill = (e.currentTarget as HTMLElement).closest('.model-pill');
    if (pill instanceof HTMLElement) pill.blur();
  };
  return (
    <div className="model-pill" tabIndex={disabled ? -1 : 0}
      title={disabled ? '生成中不可切换' : mockMode ? '离线模式：切换仅验证契约，响应恒为 mock' : '切换当前会话的模型（运行时生效）'}>
      <span className="dot"></span>
      <span className="name">{current.model || '…'}</span>
      <span className="via">via {mockMode ? 'mock' : (current.protocol || '…')}</span>
      <span>▾</span>
      <div className="model-menu" onClick={e => e.stopPropagation()}>
        {showDefault && (
          <>
            <div className="group">当前会话</div>
            <div className="mi" onClick={pick(null)}>
              ↺ 服务端默认<span className="tag">清除本会话覆盖</span>
            </div>
          </>
        )}
        {groups.map(g => (
          <div key={g.protocol}>
            <div className="group">{g.label}</div>
            {g.items.map(m => {
              const sel = m.id === current.model;
              const blocked = !mockMode && m.hasKey === false;
              return (
                <div key={m.id} className={`mi${sel ? ' sel' : ''}`}
                  style={blocked ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                  title={blocked ? `缺少凭据 ${m.apiKeyEnv ?? ''}：请在服务端配置后再选` : m.vendor}
                  onClick={blocked ? undefined : pick(m.id)}>
                  {m.id}{m.thinking ? ' 💭' : ''}
                  <span className="tag">
                    {[m.label, fmtCtx(m.contextWindow), blocked ? '缺 key' : ''].filter(Boolean).join(' · ')}
                  </span>
                  {sel && <span className="check">✓</span>}
                </div>
              );
            })}
          </div>
        ))}
        {models.length === 0 && <div className="group">模型清单加载中…</div>}
      </div>
    </div>
  );
}

function Sidebar({ sessions, activeId, view, config, onOpen, onNew, onNav }: {
  sessions: SessionMeta[];
  activeId: string | null;
  view: View;
  config: ServerConfig | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onNav: (v: View) => void;
}) {
  const wsName = config?.workspace.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">W</div>
        <div>
          <div className="name">Water</div>
          <div className="ver">v{config?.version ?? '…'} · web</div>
        </div>
      </div>
      <nav className="nav">
        <a className={`nav-item${view === 'chat' ? ' active' : ''}`} onClick={() => onNav('chat')}><span className="ico">💬</span>会话</a>
        <a className={`nav-item${view === 'tasks' ? ' active' : ''}`} onClick={() => onNav('tasks')}><span className="ico">📋</span>任务</a>
        <a className={`nav-item${view === 'plugins' ? ' active' : ''}`} onClick={() => onNav('plugins')}><span className="ico">⬡</span>插件</a>
        <a className={`nav-item${view === 'workspace' ? ' active' : ''}`} onClick={() => onNav('workspace')}><span className="ico">🗂</span>工作区</a>
        <a className={`nav-item${view === 'settings' ? ' active' : ''}`} onClick={() => onNav('settings')}><span className="ico">⚙</span>设置</a>
      </nav>
      <div className="section-title">
        最近会话 <span className="new" title="新建会话" onClick={onNew}>＋</span>
      </div>
      <div className="sessions">
        {sessions.map(s => (
          <div key={s.id}
            className={`session${s.id === activeId ? ' active' : ''}`}
            onClick={() => onOpen(s.id)}>
            <div className="t">{s.title}</div>
            <div className="m">
              <span>{s.turns} 轮</span>
              {(s.tokensIn + s.tokensOut) > 0 && <span className="tok">{fmtTok(s.tokensIn + s.tokensOut)} tok</span>}
              {s.busy && <span className="tok">进行中</span>}
              {!s.busy && s.pendingApprovals > 0 && <span className="tok">⏳ 待审批</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <div className="avatar">我</div>
        <div className="who">{wsName || 'admin@local'}</div>
        <span style={{ color: 'var(--text-2)', fontSize: 11 }}>{config?.protocol === 'mock' ? '离线模式' : '在线'}</span>
      </div>
    </aside>
  );
}

function Block({ block, sessionId, model, streaming }: {
  block: UiBlock;
  sessionId: string | null;
  model: string;
  streaming: boolean;
}) {
  switch (block.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="who">我</div>
          <div className="body">
            {block.ts && <div className="meta">{fmtTime(block.ts)}</div>}
            <div className="text"><p style={{ whiteSpace: 'pre-wrap' }}>{block.text}</p></div>
          </div>
        </div>
      );
    case 'thinking':
      return (
        <details className="think">
          <summary className="label">💭 思考过程（{block.text.length} 字）</summary>
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{block.text}</div>
        </details>
      );
    case 'text':
      return (
        <div className="msg assistant">
          <div className="who">W</div>
          <div className="body">
            {block.ts && <div className="meta">{model}{block.ts ? ` · ${fmtTime(block.ts)}` : ''}</div>}
            <div className="text">
              <p style={{ whiteSpace: 'pre-wrap' }}>{block.text}{streaming && <span className="cursor"></span>}</p>
            </div>
          </div>
        </div>
      );
    case 'tool':
      return <ToolCard block={block} sessionId={sessionId} />;
  }
}

/** 工具图标：与 P0 原型一致（read 📖 / grep 🔍 / edit ✏️ …） */
const TOOL_ICON: Record<string, string> = {
  read: '📖', grep: '🔍', glob: '🗂', edit: '✏️', write: '📝', shell: '💻',
};

/** 参数摘要：展示主参数而非整个 JSON（原型工具卡头部样式） */
function argSummary(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  switch (name) {
    case 'read': case 'edit': case 'write': return s(input.path ?? '');
    case 'glob': return s(input.pattern ?? '');
    case 'grep': {
      const inc = input.include ? ` include="${s(input.include)}"` : '';
      return `pattern="${s(input.pattern ?? '')}"${inc}`;
    }
    case 'shell': return s(input.command ?? '');
    default: return JSON.stringify(input).slice(0, 120);
  }
}

function ToolCard({ block, sessionId }: { block: Extract<UiBlock, { kind: 'tool' }>; sessionId: string | null }) {
  const [decided, setDecided] = useState(false);
  const { call, status } = block;

  const badge =
    status === 'running' ? <span className="badge run pulse">执行中</span>
    : status === 'waiting' ? <span className="badge wait">等待审批</span>
    : status === 'done' ? <span className="badge ok">完成{block.durationMs != null ? ` ${block.durationMs}ms` : ''}</span>
    : status === 'denied' ? <span className="badge deny">已拒绝</span>
    : <span className="badge deny">错误</span>;

  const decide = async (d: 'once' | 'session' | 'deny') => {
    if (!sessionId) return;
    setDecided(true);
    try { await api.approve(sessionId, call.id, d); } catch { setDecided(false); }
  };

  const waiting = status === 'waiting' && !decided;
  const icon = waiting ? '⚠' : (TOOL_ICON[call.name] ?? '⚙');

  return (
    <div className={waiting ? 'approval' : 'tool-card'}>
      <div className="head">
        <span className="ico">{icon}</span>
        <span className="name">{call.name}</span>
        <span className="arg">{argSummary(call.name, call.input)}</span>
        {badge}
      </div>
      {waiting && (
        <div className="actions" style={{ paddingBottom: 12 }}>
          <button className="btn primary" onClick={() => decide('once')}>允许一次<span className="key">⏎</span></button>
          <button className="btn" onClick={() => decide('session')}>本会话内总是允许<span className="key">a</span></button>
          <button className="btn danger" onClick={() => decide('deny')}>拒绝<span className="key">esc</span></button>
        </div>
      )}
      {/* edit：真实 diff 渲染（old → 红删 / new → 绿增） */}
      {call.name === 'edit' && typeof call.input.old === 'string' && typeof call.input.new === 'string' && (
        <div className="codeblock diff" style={{ padding: '8px 0' }}>
          {String(call.input.old).split('\n').map((l, i) => (
            <div className="ln del" key={`d${i}`}><span className="no"></span><span className="tx">{l || ' '}</span></div>
          ))}
          {String(call.input.new).split('\n').map((l, i) => (
            <div className="ln add" key={`a${i}`}><span className="no"></span><span className="tx">{l || ' '}</span></div>
          ))}
        </div>
      )}
      {/* write：新文件内容预览（前 12 行，带行号） */}
      {call.name === 'write' && typeof call.input.content === 'string' && (
        <div className="codeblock" style={{ padding: '8px 0' }}>
          {String(call.input.content).split('\n').slice(0, 12).map((l, i) => (
            <div className="ln" key={i}><span className="no">{i + 1}</span><span className="tx">{l || ' '}</span></div>
          ))}
          {String(call.input.content).split('\n').length > 12 && (
            <div className="ln"><span className="no">…</span><span className="tx" style={{ color: 'var(--text-2)' }}>（共 {String(call.input.content).split('\n').length} 行）</span></div>
          )}
        </div>
      )}
      {status === 'done' && block.result && (
        <div className="codeblock" style={{ padding: '8px 12px', whiteSpace: 'pre-wrap' }}>
          {block.result.slice(0, 600)}
        </div>
      )}
      {status === 'error' && block.result && (
        <div className="codeblock" style={{ padding: '8px 12px', whiteSpace: 'pre-wrap', color: 'var(--red)' }}>
          {block.result.slice(0, 600)}
        </div>
      )}
    </div>
  );
}

function Composer({ onSend, busy, config, usage, model, pluginCount, onNavPlugins, prefill }: {
  onSend: (text: string) => void;
  busy: boolean;
  config: ServerConfig | null;
  usage: { input: number; output: number } | null;
  model: string;
  pluginCount: number;
  onNavPlugins: () => void;
  prefill: { text: string; nonce: number } | null;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** StrictMode 下 effect 会双跑，用 nonce 去重防重复注入 */
  const consumed = useRef(0);

  // 工作区「在会话中引用」注入
  useEffect(() => {
    if (prefill && prefill.nonce !== consumed.current) {
      consumed.current = prefill.nonce;
      setText(t => (t ? `${t}\n${prefill.text}` : prefill.text));
      taRef.current?.focus();
    }
  }, [prefill]);

  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText('');
  };
  return (
    <div className="composer-wrap">
      <div className="composer">
        <div className="composer-box">
          <textarea
            ref={taRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder="向 Water 描述任务…（Enter 发送，Shift+Enter 换行，Esc 中断生成）"
          />
          <div className="composer-foot">
            {pluginCount > 0 && (
              <span className="chip" title="查看已启用插件" onClick={onNavPlugins}>⬡ 插件: {pluginCount}</span>
            )}
            <span className="spacer"></span>
            <span className="hint">
              {model}
              {usage ? ` · 上下文 ${fmtTok(usage.input)} tok` : ''}
            </span>
            <button className="send-btn" onClick={submit} disabled={busy} title="发送">➤</button>
          </div>
        </div>
      </div>
    </div>
  );
}
