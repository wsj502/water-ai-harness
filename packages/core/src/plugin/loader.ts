/**
 * 插件加载器：发现 → 校验 manifest → 动态 import → activate 收集注册。
 *
 * 发现路径（按优先级合并）：
 *   1. WATER_PLUGIN_DIRS 环境变量（冒号/分号分隔，开发用）
 *   2. <cwd>/.water/plugins（项目级）
 *   3. ~/.water/plugins（用户级）
 *
 * 失败隔离：单个插件加载失败只记入 error，不影响其他插件和主进程。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type {
  LoadedPlugin, PluginContext, PluginManifest, PluginModule, PluginRegistry,
} from './types.js';

const VALID_PERMISSIONS = new Set([
  'network', 'shell', 'fs:read', 'fs:write', 'process:spawn',
]);

export function discoverPluginDirs(cwd: string, extraDirs: string[] = []): string[] {
  const dirs: string[] = [];
  const envDirs = (process.env.WATER_PLUGIN_DIRS ?? '')
    // Windows 盘符含冒号（F:\...），必须用平台分隔符（win=';' posix=':'）
    .split(path.delimiter)
    .map(s => s.trim())
    .filter(Boolean);
  dirs.push(...extraDirs, ...envDirs,
    path.join(cwd, '.water', 'plugins'),
    path.join(homedir(), '.water', 'plugins'));
  return [...new Set(dirs)];
}

async function readManifest(dir: string): Promise<PluginManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'water-plugin.json'), 'utf8');
    const m = JSON.parse(raw) as PluginManifest;
    if (!m.name || !m.main) throw new Error('manifest 缺少 name/main');
    for (const p of m.permissions ?? []) {
      if (!VALID_PERMISSIONS.has(p)) throw new Error(`未知权限声明: ${p}`);
    }
    return m;
  } catch {
    return null; // 无 manifest 的目录直接跳过
  }
}

export async function loadPlugins(cwd: string, extraDirs: string[] = []): Promise<PluginRegistry> {
  const registry: PluginRegistry = { plugins: [], tools: [], commands: [], hooks: [] };

  for (const root of discoverPluginDirs(cwd, extraDirs)) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const manifest = await readManifest(dir);
      if (!manifest) continue;

      const loaded: LoadedPlugin = { manifest, dir, tools: [], commands: [], hooks: [] };
      try {
        const entry = pathToFileURL(path.join(dir, manifest.main)).href;
        const mod = await import(entry) as { default?: PluginModule } & PluginModule;
        const plugin: PluginModule = mod.default ?? mod;
        if (typeof plugin.activate !== 'function') {
          throw new Error('插件必须导出 activate(ctx)（default 导出或命名导出）');
        }

        const prefix = `[plugin:${manifest.name}]`;
        const ctx: PluginContext = {
          registerTool: t => loaded.tools.push(t),
          registerCommand: c => loaded.commands.push(c),
          registerHooks: h => loaded.hooks.push(h),
          pluginDir: dir,
          cwd,
          logger: {
            info: m => console.log(`${prefix} ${m}`),
            warn: m => console.warn(`${prefix} ⚠ ${m}`),
            error: m => console.error(`${prefix} ✗ ${m}`),
          },
        };
        await plugin.activate(ctx);

        // 权限治理：插件工具的风险级若低于其 manifest 声明的权限所要求的级别，提升之
        for (const t of loaded.tools) {
          const perms = manifest.permissions ?? [];
          if ((perms.includes('shell') || perms.includes('process:spawn')) && t.risk !== 'high') {
            t.risk = 'high';
          } else if ((perms.includes('network') || perms.includes('fs:write')) && t.risk === 'low') {
            t.risk = 'medium';
          }
        }

        registry.tools.push(...loaded.tools);
        registry.commands.push(...loaded.commands);
        registry.hooks.push(...loaded.hooks);
        console.log(`${prefix} ✓ ${manifest.version} · 工具 ${loaded.tools.length} · 命令 ${loaded.commands.length} · 权限 [${(manifest.permissions ?? []).join(', ') || '无'}]`);
      } catch (err) {
        loaded.error = err instanceof Error ? err.message : String(err);
        console.error(`[plugin:${manifest.name}] ✗ 加载失败: ${loaded.error}`);
      }
      registry.plugins.push(loaded);
    }
  }
  return registry;
}
