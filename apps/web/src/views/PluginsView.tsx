import { useEffect, useState } from 'react';
import { api, type PluginInfo } from '../api';

/** 插件页：接 GET /api/plugins 真实数据，样式沿用 P0 原型 */
export function PluginsView() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listPlugins().then(setPlugins).catch(e => setError(String(e)));
  }, []);

  return (
    <main className="page">
      <h1>插件</h1>
      <p className="sub">进程内 ESM 插件 + MCP 桥接。权限徽章来自 manifest 声明，加载时强制风险级提升。</p>
      {error && <div className="approval"><div className="head"><span className="warn">✕</span><span>{error}</span></div></div>}
      <div className="plugin-grid">
        {plugins.map(p => (
          <div className="plugin-card" key={p.name}>
            <div className="top">
              <div className="pico">{p.error ? '✗' : '⬡'}</div>
              <div className="pname">
                {p.name.replace(/^water-plugin-/, '')}
                <span className="at">{p.name}@{p.version}</span>
              </div>
            </div>
            <div className="pdesc">{p.error ? `加载失败：${p.error}` : p.description}</div>
            <div className="pmeta">
              <span>工具 {p.tools.length}{p.tools.length > 0 ? `（${p.tools.join(', ')}）` : ''}</span>
              {p.commands.length > 0 && <span>命令 {p.commands.join(' ')}</span>}
            </div>
            <div className="foot">
              <div className="perms">
                {p.permissions.length === 0
                  ? <span className="perm safe">无敏感权限</span>
                  : p.permissions.map(pm => <span className="perm" key={pm}>{pm}</span>)}
              </div>
              <button className="btn" disabled>{p.error ? '失败' : '已启用 ✓'}</button>
            </div>
          </div>
        ))}
        {plugins.length === 0 && !error && (
          <div style={{ color: 'var(--text-2)' }}>未发现插件（plugins/ 目录或 ~/.water/plugins）</div>
        )}
      </div>
    </main>
  );
}
