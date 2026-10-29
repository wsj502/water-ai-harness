import { useEffect, useState } from 'react';
import { api, type TaskRecord } from '../api';

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

const STATUS_BADGE: Record<TaskRecord['status'], { cls: string; text: string }> = {
  running: { cls: 'run pulse', text: '运行中' },
  done: { cls: 'ok', text: '已完成' },
  error: { cls: 'deny', text: '失败' },
  aborted: { cls: 'deny', text: '已中断' },
  max_turns: { cls: 'wait', text: '达最大轮次' },
};

type Filter = 'all' | 'running' | 'done' | 'failed';
const FILTERS: { key: Filter; ico: string; label: string }[] = [
  { key: 'all', ico: '∗', label: '全部' },
  { key: 'running', ico: '▶', label: '运行中' },
  { key: 'done', ico: '✓', label: '已完成' },
  { key: 'failed', ico: '✕', label: '失败' },
];

function matchFilter(t: TaskRecord, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'running') return t.status === 'running';
  if (f === 'done') return t.status === 'done';
  return t.status === 'error' || t.status === 'aborted' || t.status === 'max_turns';
}

/** 任务页：接 GET /api/tasks 真实数据；有运行中任务时 2s 轮询，复刻 P0 的任务卡片 */
export function TasksView() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    api.listTasks().then(setTasks).catch(e => setError(String(e)));
  }, []);

  // 有运行中任务时 2s 轮询，让进度实时可见；全部终态后自动停止
  useEffect(() => {
    if (!tasks.some(t => t.status === 'running')) return;
    const t = setTimeout(() => {
      api.listTasks().then(setTasks).catch(() => {});
    }, 2000);
    return () => clearTimeout(t);
  }, [tasks]);

  const shown = tasks.filter(t => matchFilter(t, filter));

  return (
    <main className="page">
      <h1>任务</h1>
      <p className="sub">一次任务 = 一条消息的完整 Agent Loop 运行记录，含每步工具调用。运行中的任务实时可见。</p>
      {error && <div className="approval"><div className="head"><span className="warn">✕</span><span>{error}</span></div></div>}

      <div className="task-filters">
        {FILTERS.map(f => (
          <span key={f.key}
            className={`chip${filter === f.key ? ' on' : ''}`}
            onClick={() => setFilter(f.key)}>
            {f.ico} {f.label}
          </span>
        ))}
      </div>

      <div className="task-list">
        {shown.map(t => {
          const b = STATUS_BADGE[t.status];
          const running = t.status === 'running';
          const dur = (t.finishedAt || Date.now()) - t.startedAt;
          const open = openId === t.id;
          return (
            <div key={t.id} className={`task-row${open ? ' open' : ''}`}
              onClick={() => setOpenId(open ? null : t.id)}>
              <div className="line1">
                <span className="tt">{t.title}</span>
                <span className={`badge ${b.cls}`}>{b.text}{running ? ` · 步骤 ${t.steps.length}` : ''}</span>
              </div>
              <div className="line2">
                <span>{t.id}</span>
                <span>{fmtTime(t.startedAt)} 开始</span>
                <span>{running ? '已运行' : '耗时'} {fmtDuration(dur)}</span>
                <span className="tok">{((t.tokensIn + t.tokensOut) / 1000).toFixed(1)}k tok</span>
                <span>{t.steps.length} 步</span>
              </div>
              {/* 进度条诚实化：运行中=蓝色脉冲（无总量不造假百分比），终态=满宽按状态着色 */}
              <div className="bar">
                <i className={running ? 'run' : t.status === 'done' ? 'done' : 'fail'}
                  style={{ width: '100%' }}></i>
              </div>
              {open && (
                <div className="task-detail">
                  {t.steps.length === 0 && <div className="step"><span className="st-ico">·</span><span>{running ? '等待第一个工具调用…' : '无工具调用（纯文本回复）'}</span></div>}
                  {t.steps.map((s, i) => (
                    <div className="step" key={i}>
                      <span className="st-ico">{s.ok === null ? '⊘' : s.ok ? '✓' : '✗'}</span>
                      <span>{s.tool} {s.summary} <span style={{ color: 'var(--text-2)' }}>· {fmtDuration(s.durationMs)}</span></span>
                    </div>
                  ))}
                  {running && <div className="step"><span className="st-ico">⏳</span><span style={{ color: 'var(--amber)' }}>Loop 进行中…</span></div>}
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && !error && (
          <div style={{ color: 'var(--text-2)' }}>
            {tasks.length === 0 ? '暂无任务记录——去会话里发一条消息试试' : '该筛选条件下没有任务'}
          </div>
        )}
      </div>
    </main>
  );
}
