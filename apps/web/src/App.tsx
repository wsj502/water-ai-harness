import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ServerConfig, type SessionMeta } from './api';
import { applyEvent, hydrateBlocks, type UiBlock } from './state/blocks';

export default function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(e => setError(String(e)));
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  // 自动滚到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [blocks]);

  const openSession = useCallback(async (id: string) => {
    setActiveId(id);
    setError(null);
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
        sid = await api.createSession();
        setActiveId(sid);
      }
      setBlocks(bs => [...bs, { kind: 'user', text }]);
      const ac = new AbortController();
      abortRef.current = ac;
      await api.streamMessage(sid, text, ev => {
        setBlocks(bs => applyEvent(bs, ev));
      }, ac.signal);
      api.listSessions().then(setSessions).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [activeId, busy]);

  const newSession = useCallback(() => {
    abortRef.current?.abort();
    setActiveId(null);
    setBlocks([]);
  }, []);

  return (
    <div className="app">
      <Topbar config={config} />
      <Sidebar sessions={sessions} activeId={activeId} onOpen={openSession} onNew={newSession} />
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
            {blocks.map((b, i) => <Block key={i} block={b} sessionId={activeId} />)}
            {error && <div className="approval"><div className="head"><span className="warn">✕</span><span>{error}</span></div></div>}
            {busy && <div style={{ color: 'var(--text-2)', fontSize: 12 }}>生成中…</div>}
          </div>
        </div>
        <Composer onSend={send} busy={busy} config={config} />
      </main>
      <footer className="statusbar">
        <span className="item"><span className="ok">●</span> provider: {config?.protocol ?? '…'}</span>
        <span className="item">{config?.baseUrl ?? ''}</span>
        <span className="spacer"></span>
        <span className="item">workspace: {config?.workspace ?? ''}</span>
        <span className="item">water v{config?.version ?? ''}</span>
      </footer>
    </div>
  );
}

function Topbar({ config }: { config: ServerConfig | null }) {
  return (
    <header className="topbar">
      <span className="crumb">Water <b>Web</b></span>
      <span className="spacer"></span>
      <div className="model-pill">
        <span className="dot"></span>
        <span className="name">{config?.model ?? '…'}</span>
        <span className="via">via {config?.protocol ?? ''}</span>
      </div>
    </header>
  );
}

function Sidebar({ sessions, activeId, onOpen, onNew }: {
  sessions: SessionMeta[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">W</div>
        <div>
          <div className="name">Water</div>
          <div className="ver">web · dev</div>
        </div>
      </div>
      <div className="section-title">
        会话 <span className="new" title="新建会话" onClick={onNew}>＋</span>
      </div>
      <div className="sessions">
        {sessions.map(s => (
          <div key={s.id}
            className={`session${s.id === activeId ? ' active' : ''}`}
            onClick={() => onOpen(s.id)}>
            <div className="t">{s.title}</div>
            <div className="m"><span>{s.turns} 轮</span>{s.busy && <span className="tok">进行中</span>}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Block({ block, sessionId }: { block: UiBlock; sessionId: string | null }) {
  switch (block.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="who">我</div>
          <div className="body"><div className="text"><p style={{ whiteSpace: 'pre-wrap' }}>{block.text}</p></div></div>
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
          <div className="body"><div className="text"><p style={{ whiteSpace: 'pre-wrap' }}>{block.text}</p></div></div>
        </div>
      );
    case 'tool':
      return <ToolCard block={block} sessionId={sessionId} />;
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

  return (
    <div className={status === 'waiting' && !decided ? 'approval' : 'tool-card'}>
      <div className="head">
        <span className="ico">{status === 'waiting' && !decided ? '⚠' : '⚙'}</span>
        <span className="name">{call.name}</span>
        <span className="arg">{JSON.stringify(call.input).slice(0, 120)}</span>
        {badge}
      </div>
      {status === 'waiting' && !decided && (
        <div className="actions" style={{ paddingBottom: 12 }}>
          <button className="btn primary" onClick={() => decide('once')}>允许一次</button>
          <button className="btn" onClick={() => decide('session')}>本会话内总是允许</button>
          <button className="btn danger" onClick={() => decide('deny')}>拒绝</button>
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

function Composer({ onSend, busy, config }: {
  onSend: (text: string) => void;
  busy: boolean;
  config: ServerConfig | null;
}) {
  const [text, setText] = useState('');
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
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            placeholder="向 Water 描述任务…（Enter 发送，Shift+Enter 换行）"
          />
          <div className="composer-foot">
            <span className="spacer"></span>
            <span className="hint">{config?.model ?? ''} · via {config?.protocol ?? ''}</span>
            <button className="send-btn" onClick={submit} disabled={busy} title="发送">➤</button>
          </div>
        </div>
      </div>
    </div>
  );
}
