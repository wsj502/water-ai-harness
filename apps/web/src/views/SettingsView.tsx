import { useEffect, useState } from 'react';
import { api, type ServerConfig } from '../api';

type Theme = 'system' | 'light' | 'dark';

function getTheme(): Theme {
  try { return (localStorage.getItem('water-theme') as Theme) || 'system'; } catch { return 'system'; }
}

function applyTheme(t: Theme) {
  try {
    if (t === 'system') {
      localStorage.removeItem('water-theme');
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem('water-theme', t);
      document.documentElement.dataset.theme = t;
    }
  } catch { /* ignore */ }
}

/** 设置页：真实配置展示 + 可用的主题切换 */
export function SettingsView() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme());

  useEffect(() => { api.config().then(setConfig).catch(() => {}); }, []);

  const changeTheme = (t: Theme) => { setTheme(t); applyTheme(t); };

  return (
    <main className="page">
      <h1>设置</h1>
      <p className="sub">配置以服务端为准（flag &gt; env &gt; config.json &gt; 默认），此页只读展示。</p>

      <div className="settings">
        <fieldset className="fieldset">
          <legend>Provider（服务端当前生效）</legend>
          <div className="row"><div className="lab">厂商协议</div><div className="ctl">{config?.protocol ?? '…'}</div></div>
          <div className="row"><div className="lab">模型</div><div className="ctl">{config?.model ?? '…'}</div></div>
          <div className="row"><div className="lab">Base URL</div><div className="ctl">{config?.baseUrl ?? '…'}</div></div>
          <div className="row"><div className="lab">工作区</div><div className="ctl">{config?.workspace ?? '…'}</div></div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>外观</legend>
          <div className="row">
            <div className="lab">主题<small>跟随系统时监听 prefers-color-scheme</small></div>
            <div className="ctl">
              <select className="select" value={theme} onChange={e => changeTheme(e.target.value as Theme)}>
                <option value="system">跟随系统</option>
                <option value="dark">深色</option>
                <option value="light">浅色</option>
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>关于</legend>
          <div className="row"><div className="lab">版本</div><div className="ctl">water v{config?.version ?? '…'}</div></div>
          <div className="row"><div className="lab">许可</div><div className="ctl">MIT · 仅供个人学习研究</div></div>
        </fieldset>
      </div>
    </main>
  );
}
