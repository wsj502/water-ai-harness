import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ModelInfo, type ServerConfig, type SessionMeta, type ServerEvent, type WorkspaceInfo } from './api';
import { applyEvent, argSummary, hydrateBlocks, type UiBlock } from './state/blocks';
import { Md } from './Md';
import { diffStats, lineDiff } from './diff';
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
  /** 侧栏会话过滤：false 最近会话 / true 归档（M7A） */
  const [archivedView, setArchivedView] = useState(false);
  /** 工作区注册表 + 选中项（决定下一个新会话的绑定，M7B） */
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [pendingWs, setPendingWs] = useState('default');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback((archived: boolean) => {
    return api.listSessions(archived).then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(e => setError(String(e)));
    api.models().then(m => { setModels(m.models); setMockMode(m.mock); }).catch(() => {});
    api.workspaces().then(setWorkspaces).catch(() => {});
    refreshSessions(false);
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
      const list = await api.listSessions().catch(() => []);
      setSessions(list);
      const meta = list.find(s => s.id === id);
      if (meta?.busy) {
        // M19：busy 会话（刷新时仍在跑）——历史只水合到本次运行的最后一条 user 消息，
        // 其后由事件回放（since=0）渲染（避免与已入史的运行内消息重复）；
        // 轮询用递增游标逐段补帧（宽限期内运行继续产出事件）
        const lastUser = h.messages.findLastIndex(m => m.role === 'user');
        setBlocks(hydrateBlocks(h.messages.slice(0, lastUser + 1)));
        setBusy(true);
        void (async () => {
          try {
            let cursor = 0;
            for (;;) {
              const { events, busy: still } = await api.eventsSince(id, cursor);
              for (const e of events) {
                if (e.ev.type === 'usage') setUsage({ input: e.ev.inputTokens, output: e.ev.outputTokens });
                setBlocks(bs => applyEvent(bs, e.ev));
                cursor = Math.max(cursor, e.seq);
              }
              if (events.some(e => (e.ev as { type: string }).type === 'finish')) break;
              if (!still) break;
              await new Promise(r => setTimeout(r, 1000));
            }
          } catch { /* 接流失败则保持历史视图 */ }
          finally { setBusy(false); }
          api.listSessions().then(setSessions).catch(() => {});
        })();
      } else {
        setBlocks(hydrateBlocks(h.messages));
      }
    } catch (e) {
      setBlocks([]);
      setError(String(e));
    }
  }, []);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || busy) return;
    if (activeMeta?.archived) { setError('会话已归档：请先取消归档再继续对话'); return; }
    setBusy(true);
    setError(null);
    try {
      let sid = activeId;
      if (!sid) {
        const created = await api.createSession({
          ...(pendingWs !== 'default' ? { workspaceId: pendingWs } : {}),
          ...(pendingModel ? { model: pendingModel } : {}),
        });
        sid = created.id;
        setActiveId(sid);
        setPendingModel(null);
      }
      setBlocks(bs => [...bs, { kind: 'user', text, ts: Date.now() }]);
      const ac = new AbortController();
      abortRef.current = ac;

      const handle = (ev: ServerEvent) => {
        if (ev.type === 'usage') setUsage({ input: ev.inputTokens, output: ev.outputTokens });
        setBlocks(bs => applyEvent(bs, ev));
      };

      // 断线补帧（M3）：流异常断开（非用户中断）→ 轮询 events 端点直到 finish
      let lastSeq = 0;
      try {
        await api.streamMessage(sid, text, (ev, id) => {
          if (id !== undefined) lastSeq = id;
          handle(ev);
        }, ac.signal);
      } catch (streamErr) {
        if (ac.signal.aborted) throw streamErr; // 用户主动中断，不补帧
        const deadline = Date.now() + 10 * 60_000;
        for (;;) {
          if (Date.now() > deadline) throw new Error('断线补帧超时（10 分钟）');
          const { events } = await api.eventsSince(sid, lastSeq).catch(() => ({ events: [], busy: false }));
          for (const e of events) {
            if (e.seq > lastSeq) lastSeq = e.seq;
            handle(e.ev);
            if (e.ev.type === 'finish') { api.listSessions().then(setSessions).catch(() => {}); return; }
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
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
        const list = await api.listSessions(archivedView);
        setSessions(list);
      } catch (e) { setError(String(e)); }
    } else {
      setPendingModel(modelId);
    }
  }, [activeId, archivedView]);

  /** M7A：归档/取消归档 */
  const toggleArchive = useCallback(async (s: SessionMeta) => {
    try {
      await api.setSessionConfig(s.id, { archived: !s.archived });
      await refreshSessions(archivedView);
    } catch (e) { setError(String(e)); }
  }, [archivedView, refreshSessions]);

  /** M7A：删除会话（确认；删除当前会话则回到空白态） */
  const removeSession = useCallback(async (s: SessionMeta) => {
    if (!window.confirm(`删除会话「${s.title}」？\n历史与任务记录将一并移除，不可恢复。`)) return;
    try {
      await api.deleteSession(s.id);
      if (s.id === activeId) {
        abortRef.current?.abort();
        setActiveId(null); setBlocks([]); setUsage(null); setError(null);
      }
      await refreshSessions(archivedView);
    } catch (e) { setError(String(e)); }
  }, [archivedView, activeId, refreshSessions]);

  /** M7A：侧栏过滤切换（最近会话 ↔ 归档） */
  const switchFilter = useCallback((to: boolean) => {
    setArchivedView(to);
    refreshSessions(to);
  }, [refreshSessions]);

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

  /** 生效工作区：激活会话的绑定 > 侧栏选中（决定新会话/工作区页的根） */
  const effWsId = activeMeta?.workspaceId ?? pendingWs;
  const effWsName = workspaces.find(w => w.id === effWsId)?.name ?? effWsId;

  return (
    <div className="app">
      <Topbar config={config} sessionTitle={view === 'chat' ? activeTitle : null} view={view}
        models={models} mockMode={mockMode}
        current={{ model: effModel, protocol: effProtocol }}
        showDefault={sessionOverridden} disabled={busy} onPick={pickModel} />
      <Sidebar sessions={sessions} activeId={activeId} view={view} config={config}
        onOpen={openSession} onNew={newSession} onNav={setView}
        archivedView={archivedView} onFilter={switchFilter}
        onArchive={toggleArchive} onDelete={removeSession}
        workspaces={workspaces} pendingWs={pendingWs} onPickWs={setPendingWs}
        effWsId={effWsId} />
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
        <Composer onSend={send} busy={busy || Boolean(activeMeta?.archived)} config={config} usage={usage} model={effModel}
          pluginCount={pluginCount} onNavPlugins={() => setView('plugins')} prefill={prefill}
          archived={Boolean(activeMeta?.archived)} />
      </main>
      )}
      {view === 'plugins' && <PluginsView />}
      {view === 'tasks' && <TasksView />}
      {view === 'workspace' && <WorkspaceView onInject={injectRef} workspaceId={effWsId} />}
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

function Sidebar({ sessions, activeId, view, config, onOpen, onNew, onNav, archivedView, onFilter, onArchive, onDelete, workspaces, pendingWs, onPickWs, effWsId }: {
  sessions: SessionMeta[];
  activeId: string | null;
  view: View;
  config: ServerConfig | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onNav: (v: View) => void;
  archivedView: boolean;
  onFilter: (to: boolean) => void;
  onArchive: (s: SessionMeta) => void;
  onDelete: (s: SessionMeta) => void;
  workspaces: WorkspaceInfo[];
  pendingWs: string;
  onPickWs: (id: string) => void;
  effWsId: string;
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
      {workspaces.length > 1 && (
        <div className="ws-picker" title="工作区：决定新会话绑定的根目录（会话创建后不可换根）">
          <span className="ws-ico">🗂</span>
          <select className="select ws-select" value={pendingWs} onChange={e => onPickWs(e.target.value)}>
            {workspaces.map(w => (
              <option key={w.id} value={w.id}>{w.name}{w.default ? '（默认）' : ''}</option>
            ))}
          </select>
        </div>
      )}
      <nav className="nav">
        <a className={`nav-item${view === 'chat' ? ' active' : ''}`} onClick={() => onNav('chat')}><span className="ico">💬</span>会话</a>
        <a className={`nav-item${view === 'tasks' ? ' active' : ''}`} onClick={() => onNav('tasks')}><span className="ico">📋</span>任务</a>
        <a className={`nav-item${view === 'plugins' ? ' active' : ''}`} onClick={() => onNav('plugins')}><span className="ico">⬡</span>插件</a>
        <a className={`nav-item${view === 'workspace' ? ' active' : ''}`} onClick={() => onNav('workspace')}><span className="ico">🗂</span>工作区</a>
        <a className={`nav-item${view === 'settings' ? ' active' : ''}`} onClick={() => onNav('settings')}><span className="ico">⚙</span>设置</a>
      </nav>
      <div className="section-title">
        {archivedView ? '📦 归档' : '最近会话'}
        {archivedView
          ? <span className="new" title="返回最近会话" onClick={() => onFilter(false)}>↩</span>
          : <>
            <span className="filter" title="查看归档会话" onClick={() => onFilter(true)}>📦</span>
            <span className="new" title="新建会话" onClick={onNew}>＋</span>
          </>}
      </div>
      <div className="sessions">
        {sessions.map(s => (
          <div key={s.id}
            className={`session${s.id === activeId ? ' active' : ''}`}
            onClick={() => onOpen(s.id)}>
            <div className="t">{s.title}{s.archived && !archivedView ? ' 📦' : ''}</div>
            <div className="m">
              <span>{s.turns} 轮</span>
              {(s.tokensIn + s.tokensOut) > 0 && <span className="tok">{fmtTok(s.tokensIn + s.tokensOut)} tok</span>}
              {s.busy && <span className="tok">进行中</span>}
              {!s.busy && (s.queued ?? 0) > 0 && <span className="tok">排队 {s.queued}</span>}
              {!s.busy && s.pendingApprovals > 0 && <span className="tok">⏳ 待审批</span>}
              {s.workspaceId && s.workspaceId !== 'default' && <span className="tok" title={`工作区 ${s.workspaceId}`}>🗂 {s.workspaceId}</span>}
            </div>
            {!s.busy && (
              <div className="ops" onClick={e => e.stopPropagation()}>
                <span className="op" title={s.archived ? '取消归档' : '归档（历史保留，停用对话）'}
                  onClick={() => onArchive(s)}>{s.archived ? '↩' : '📦'}</span>
                <span className="op danger" title="删除会话（不可恢复）"
                  onClick={() => onDelete(s)}>🗑</span>
              </div>
            )}
          </div>
        ))}
        {archivedView && sessions.length === 0 && (
          <div style={{ color: 'var(--text-2)', fontSize: 12, padding: '8px 10px' }}>暂无归档会话</div>
        )}
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
    case 'notice':
      return (
        <div style={{
          color: 'var(--text-2)', fontSize: 12, textAlign: 'center',
          margin: '6px 0', userSelect: 'none',
        }}>{block.text}</div>
      );
    case 'text':
      return (
        <div className="msg assistant">
          <div className="who">W</div>
          <div className="body">
            {block.ts && <div className="meta">{model}{block.ts ? ` · ${fmtTime(block.ts)}` : ''}</div>}
            <div className="text">
              <Md text={block.text} />
              {streaming && <span className="cursor"></span>}
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
  read: '📖', grep: '🔍', glob: '🗂', edit: '✏️', write: '📝', shell: '💻', task: '🤖',
};

function ToolCard({ block, sessionId }: { block: Extract<UiBlock, { kind: 'tool' }>; sessionId: string | null }) {
  const [decided, setDecided] = useState(false);
  const [decidedSub, setDecidedSub] = useState<string[]>([]);
  const subRef = useRef<HTMLDetailsElement>(null);
  const { call, status } = block;

  // M18 时间线：轮次分组 + 节点统计 + 待审批项（审批到来时自动展开折叠区，但绝不强制收起）
  const timeline = block.subTimeline ?? [];
  const subToolCount = timeline.reduce((n, t) => n + t.nodes.filter(x => x.kind === 'tool').length, 0);
  const waitingApprovals = timeline.flatMap(t =>
    t.nodes.filter((x): x is Extract<typeof x, { kind: 'approval' }> => x.kind === 'approval' && x.status === 'waiting'));
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (waitingApprovals.length > 0 && !wasWaiting.current) subRef.current?.setAttribute('open', '');
    wasWaiting.current = waitingApprovals.length > 0;
  }, [waitingApprovals.length]);

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

  /** M15：子级审批（callId 为 `${task调用id}:${子id}` 命名空间，服务端按完整 id 挂起/resolve） */
  const decideSub = async (fullId: string, d: 'once' | 'deny') => {
    if (!sessionId) return;
    setDecidedSub(ids => [...ids, fullId]);
    try { await api.approve(sessionId, fullId, d); } catch { setDecidedSub(ids => ids.filter(x => x !== fullId)); }
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
      {/* edit：行级 diff（LCS，- 红 / + 绿 / 上下文灰） */}
      {call.name === 'edit' && typeof call.input.old === 'string' && typeof call.input.new === 'string' && (
        (() => {
          const d = lineDiff(String(call.input.old), String(call.input.new));
          const st = diffStats(d);
          return (
            <div className="codeblock diff" style={{ padding: '8px 0' }}>
              <div className="diff-stat">+{st.add} −{st.del}</div>
              {d.map((l, i) => (
                <div className={`ln ${l.type}`} key={i}>
                  <span className="no"></span>
                  <span className="tx">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          );
        })()
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
      {/* M18：子代理时间线（轮次分组 · 缩进嵌套 · 状态着色；M15 子级审批是时间线内的一等节点） */}
      {call.name === 'task' && timeline.length > 0 && (
        <details className="sub-proc" ref={subRef}>
          <summary className="label">
            🤖 子代理过程（{timeline.length} 轮{subToolCount > 0 ? ` · ${subToolCount} 次工具` : ''}
            {waitingApprovals.length > 0 ? ` · ⚠ ${waitingApprovals.length} 项待审批` : ''}）
          </summary>
          <div className="sub-timeline">
            {timeline.map((t, ti) => (
              <div className="sub-turn" key={ti}>
                <div className="sub-turn-head">第 {t.turn} 轮</div>
                {t.nodes.map((n, ni) => {
                  if (n.kind === 'text') {
                    return (
                      <div className="sub-node sub-text" key={ni}>
                        {n.text.slice(0, 400)}{n.text.length > 400 ? '…' : ''}
                      </div>
                    );
                  }
                  if (n.kind === 'tool') {
                    return (
                      <div className="sub-node" key={ni}>
                        <span className={`chip ${n.status === 'done' ? 'ok' : n.status === 'error' || n.status === 'denied' ? 'deny' : ''}`}>
                          {TOOL_ICON[n.name] ?? '⚙'} {n.name}
                          {n.status === 'running' ? ' …' : n.status === 'error' ? ' ✕' : n.status === 'denied' ? ' ⛔' : ''}
                        </span>
                        <span className="sub-arg">{n.summary}</span>
                        {n.result && (
                          <span className="sub-result">{n.result.slice(0, 160)}{n.result.length > 160 ? '…' : ''}</span>
                        )}
                      </div>
                    );
                  }
                  const acted = n.status !== 'waiting' || decidedSub.includes(n.fullId);
                  return (
                    <div className="approval sub-node" key={ni}>
                      <div className="head">
                        <span className="ico">{n.status === 'denied' ? '⛔' : acted ? '✅' : '⚠'}</span>
                        <span className="name">子级 {n.name}</span>
                        <span className="arg">{n.summary}</span>
                        {n.status === 'waiting' && !decidedSub.includes(n.fullId)
                          ? <span className="badge wait">等待审批</span>
                          : <span className={`badge ${n.status === 'denied' ? 'deny' : 'ok'}`}>
                            {n.status === 'denied' ? '已拒绝' : n.status === 'approved' ? '已批准' : '已提交…'}
                          </span>}
                      </div>
                      {!acted && (
                        <div className="actions" style={{ paddingBottom: 8 }}>
                          <button className="btn primary" onClick={() => decideSub(n.fullId, 'once')}>允许一次</button>
                          <button className="btn danger" onClick={() => decideSub(n.fullId, 'deny')}>拒绝</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </details>
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

function Composer({ onSend, busy, config, usage, model, pluginCount, onNavPlugins, prefill, archived }: {
  onSend: (text: string) => void;
  busy: boolean;
  config: ServerConfig | null;
  usage: { input: number; output: number } | null;
  model: string;
  pluginCount: number;
  onNavPlugins: () => void;
  prefill: { text: string; nonce: number } | null;
  archived: boolean;
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
    if (!text.trim() || busy || archived) return;
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
            disabled={archived}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder={archived
              ? '📦 会话已归档（历史可查看）——侧栏 ↩ 取消归档后可继续对话'
              : '向 Water 描述任务…（Enter 发送，Shift+Enter 换行，Esc 中断生成）'}
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
