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
  done: { cls: 'ok', text: '已完成' },
  error: { cls: 'deny', text: '失败' },
  aborted: { cls: 'deny', text: '已中断' },
  max_turns: { cls: 'wait', text: '达最大轮次' },
};

/** 任务页：接 GET /api/tasks 真实数据，复刻 P0 原型的任务卡片 */
export function TasksView() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => { api.listTasks().then(setTasks).catch(e => setError(String(e))); }, []);

  return (
    <main className="page">
      <h1>任务</h1>
      <p className="sub">一次任务 = 一条消息的完整 Agent Loop 运行记录，含每步工具调用。</p>
      {error && <div className="approval"><div className="head"><span className="warn">✕</span><span>{error}</span></div></div>}
      <div className="task-list">
        {tasks.map(t => {
          const b = STATUS_BADGE[t.status];
          const dur = t.finishedAt - t.startedAt;
          const open = openId === t.id;
          return (
            <div key={t.id} className={`task-row${open ? ' open' : ''}`}
              onClick={() => setOpenId(open ? null : t.id)}>
              <div className="line1">
                <span className="tt">{t.title}</span>
                <span className={`badge ${b.cls}`}>{b.text}</span>
              </div>
              <div className="line2">
                <span>{t.id}</span>
                <span>{fmtTime(t.startedAt)} 开始</span>
                <span>耗时 {fmtDuration(dur)}</span>
                <span className="tok">{((t.tokensIn + t.tokensOut) / 1000).toFixed(1)}k tok</span>
                <span>{t.steps.length} 步</span>
              </div>
              <div className="bar">
                <i className={t.status === 'done' ? 'done' : t.status === 'error' || t.status === 'aborted' ? 'fail' : ''}
                  style={{ width: t.status === 'done' ? '100%' : '60%' }}></i>
              </div>
              {open && (
                <div className="task-detail">
                  {t.steps.length === 0 && <div className="step"><span className="st-ico">·</span><span>无工具调用（纯文本回复）</span></div>}
                  {t.steps.map((s, i) => (
                    <div className="step" key={i}>
                      <span className="st-ico">{s.ok === null ? '⊘' : s.ok ? '✓' : '✗'}</span>
                      <span>{s.tool} {s.summary} <span style={{ color: 'var(--text-2)' }}>· {fmtDuration(s.durationMs)}</span></span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {tasks.length === 0 && !error && (
          <div style={{ color: 'var(--text-2)' }}>暂无任务记录——去会话里发一条消息试试</div>
        )}
      </div>
    </main>
  );
}
