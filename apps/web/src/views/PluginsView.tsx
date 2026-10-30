import { useEffect, useState } from 'react';
import { api, type PluginInfo } from '../api';

/** 插件页：接 GET /api/plugins 真实数据，样式沿用 P0 原型 */
export function PluginsView() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [configCommands, setConfigCommands] = useState<Array<{ name: string; description?: string }>>([]);
  const [configTools, setConfigTools] = useState<Array<{ name: string; kind: 'prompt' | 'http'; description: string; hasParameters: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listPlugins().then(setPlugins).catch(e => setError(String(e)));
    api.configCommands().then(setConfigCommands).catch(() => {});
    api.configTools().then(setConfigTools).catch(() => {});
  }, []);

  return (
    <main className="page">
      <h1>插件</h1>
      <p className="sub">进程内 ESM 插件 + MCP 桥接（支持 mcpServers 多 server）。权限徽章来自 manifest 声明，加载时强制风险级提升。</p>
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
        {configCommands.length > 0 && (
          <div className="plugin-card">
            <div className="top">
              <div className="pico">📄</div>
              <div className="pname">配置式命令<span className="at">~/.water/config.json</span></div>
            </div>
            <div className="pdesc">零代码扩展：纯 prompt 模板，$ARGUMENTS 替换参数（优先级：内置 &gt; ESM 插件 &gt; 配置式）</div>
            <div className="pmeta">
              {configCommands.map(c => (
                <span key={c.name} title={c.description ?? ''}>{c.name}</span>
              ))}
            </div>
            <div className="foot"><div className="perms"><span className="perm safe">无执行逻辑</span></div></div>
          </div>
        )}
        {configTools.length > 0 && (
          <div className="plugin-card">
            <div className="top">
              <div className="pico">🔧</div>
              <div className="pname">配置式工具<span className="at">~/.water/config.json</span></div>
            </div>
            <div className="pdesc">配置即插件进阶（M17/M22）：声明 JSON Schema 的工具直接进注册表——prompt 型（模板 $参数 替换）/ http 型（域名白名单 + $env: 凭据插值，逐次审批）</div>
            <div className="pmeta">
              {configTools.map(t => (
                <span key={t.name} title={t.description}>{t.name}{t.kind === 'http' ? ' 🌐' : ''}{t.hasParameters ? '()' : ''}</span>
              ))}
            </div>
            <div className="foot"><div className="perms"><span className="perm safe">{configTools.every(t => t.kind !== 'http') ? '零执行逻辑' : 'http 受白名单约束'}</span></div></div>
          </div>
        )}
        {plugins.length === 0 && configCommands.length === 0 && configTools.length === 0 && !error && (
          <div style={{ color: 'var(--text-2)' }}>未发现插件（plugins/ 目录或 ~/.water/plugins）</div>
        )}
      </div>
    </main>
  );
}
