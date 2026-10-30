import { useEffect, useState } from 'react';
import { api, type KeyStatus, type PermissionRuleInfo, type ServerConfig } from '../api';

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

const RISK_BADGE: Record<PermissionRuleInfo['risk'], { cls: string; text: string }> = {
  low: { cls: 'ok', text: '低' },
  medium: { cls: 'run', text: '中' },
  high: { cls: 'deny', text: '高' },
};

/** 设置页：真实配置 + 真实审批规则表 + 真实快捷键（全部来自服务端/实际实现，无摆设） */
export function SettingsView() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [rules, setRules] = useState<PermissionRuleInfo[]>([]);
  const [theme, setTheme] = useState<Theme>(getTheme());
  // BYOK（#67）：key 状态与录入表单
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
    api.permissions().then(p => setRules(p.rules)).catch(() => {});
    api.listKeys().then(setKeys).catch(() => {});
  }, []);

  const refreshKeys = () => {
    api.listKeys().then(setKeys).catch(() => {});
  };

  const saveKey = async (envName: string) => {
    const value = (draft[envName] ?? '').trim();
    if (!value) return;
    setKeyMsg(null);
    try {
      const r = await api.setKey(envName, value);
      setKeyMsg(`已录入 ${envName}（${r.hint}）——只存服务端内存，重启后需重新录入`);
      setDraft(d => ({ ...d, [envName]: '' }));
      refreshKeys();
    } catch (e) {
      setKeyMsg(`录入失败：${String(e)}`);
    }
  };

  const removeKey = async (envName: string) => {
    setKeyMsg(null);
    try {
      await api.deleteKey(envName);
      setKeyMsg(`已清除 ${envName}`);
      refreshKeys();
    } catch (e) {
      setKeyMsg(`清除失败：${String(e)}`);
    }
  };

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
          <div className="row">
            <div className="lab">API Key<small>只注入进程内存，不落盘</small></div>
            <div className="ctl">
              {config?.hasKey
                ? <span className="env-note" style={{ display: 'inline-block', marginTop: 0 }}>✓ 已从环境变量 {config.apiKeyEnv} 注入</span>
                : <span className="txtdim">未配置（{config?.apiKeyEnv ?? '?'}），用 start-secure 启动注入</span>}
            </div>
          </div>
          <div className="row"><div className="lab">工作区</div><div className="ctl">{config?.workspace ?? '…'}</div></div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>API 密钥（BYOK · #67）</legend>
          <div className="row" style={{ display: 'block' }}>
            <div className="lab" style={{ marginBottom: 8 }}>
              按模型注册表录入<small>key 只存服务端内存（重启即清），只发往注册表声明的端点——baseUrl 不可从前端指定（防外泄）</small>
            </div>
            <div className="rule-table">
              <div className="rule-row rule-head">
                <span>环境变量名</span><span>状态</span><span>录入 / 清除</span><span></span>
              </div>
              {keys.map(k => (
                <div className="rule-row" key={k.apiKeyEnv}>
                  <span><code>{k.apiKeyEnv}</code></span>
                  <span>{k.source === 'byok'
                    ? <span className="badge ok">已录入（{k.hint}）</span>
                    : k.source === 'env'
                      ? <span className="badge run">环境变量（{k.hint}）</span>
                      : <span className="badge deny">未配置</span>}</span>
                  <span>
                    <input
                      className="input"
                      type="password"
                      placeholder={k.source === 'none' ? '粘贴 key 后保存' : '更新为新的 key'}
                      value={draft[k.apiKeyEnv] ?? ''}
                      onChange={e => setDraft(d => ({ ...d, [k.apiKeyEnv]: e.target.value }))}
                    />
                  </span>
                  <span>
                    <button className="btn" disabled={!(draft[k.apiKeyEnv] ?? '').trim()} onClick={() => void saveKey(k.apiKeyEnv)}>保存</button>
                    {k.source === 'byok' && <button className="btn danger" style={{ marginLeft: 6 }} onClick={() => void removeKey(k.apiKeyEnv)}>清除</button>}
                  </span>
                </div>
              ))}
              {keys.length === 0 && <div className="rule-row"><span className="txtdim">加载中…</span></div>}
            </div>
            {keyMsg && <p className="env-note" style={{ marginTop: 8 }}>{keyMsg}</p>}
            <p className="txtdim" style={{ marginTop: 8 }}>保存后模型菜单的「缺凭据」模型即可用；环境变量来源（.env/DPAPI 注入）不可在此清除。</p>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend>权限与审批（内核实时规则）</legend>
          <div className="row" style={{ display: 'block' }}>
            <div className="lab" style={{ marginBottom: 8 }}>
              审批规则表<small>风险级决定默认策略；会话内选择「总是允许」后按工具/命令前缀记忆</small>
            </div>
            <div className="rule-table">
              <div className="rule-row rule-head">
                <span>工具</span><span>风险级</span><span>默认策略</span><span>会话覆盖</span>
              </div>
              {rules.map(r => (
                <div className="rule-row" key={r.tool}>
                  <span><code>{r.tool}</code></span>
                  <span className={`badge ${RISK_BADGE[r.risk].cls}`}>{RISK_BADGE[r.risk].text}</span>
                  <span>{r.policy}</span>
                  <span className="txtdim">—</span>
                </div>
              ))}
              {rules.length === 0 && <div className="rule-row"><span className="txtdim">加载中…</span></div>}
            </div>
          </div>
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
          <legend>快捷键（当前真实生效）</legend>
          <div className="row"><div className="lab">发送消息</div><div className="ctl"><span className="kbd">Enter</span> <span className="txtdim">换行</span> <span className="kbd">Shift</span>+<span className="kbd">Enter</span></div></div>
          <div className="row"><div className="lab">审批：允许一次 / 总是允许 / 拒绝</div><div className="ctl"><span className="kbd">Enter</span> / <span className="kbd">A</span> / <span className="kbd">Esc</span></div></div>
          <div className="row"><div className="lab">中断当前生成</div><div className="ctl"><span className="kbd">Esc</span></div></div>
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
