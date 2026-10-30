/**
 * 工作区注册表（M7B）：多根目录管理与白名单校验。
 *
 * 解决的问题：server 曾是单工作区进程（启动时 cfg.cwd 定死）——与 v0.1.0
 * 的「模型写死」同构。现在工作区成为注册表实体，会话创建时绑定其一。
 *
 * 来源（合并去重，id 冲突时后者覆盖前者，default 永不被覆盖）：
 *   1. 启动目录 → id 'default'（永在列表，不可删）
 *   2. WATER_WORKSPACES 环境变量（平台分隔符分隔路径，id = 目录名）
 *   3. ~/.water/workspaces.json：[{id, name?, path}]（用户级持久注册表）
 *
 * 安全模型（同 M1 的 baseUrl 逻辑）：**前端只能传注册表内的 id，不能传
 * 任意路径**——防目录逃逸扫描任意磁盘。凭据红线：注册表只存路径元数据，
 * 读取时扫描拒绝任何 key/token/secret 字段（沿用 config.json 的纪律）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface WorkspaceInfo {
  id: string;
  name: string;
  /** 绝对路径（已 resolve） */
  path: string;
  /** 启动目录，不可删除/覆盖 */
  default: boolean;
}

interface RegistryEntry {
  id?: unknown;
  name?: unknown;
  path?: unknown;
}

function normalizeId(id: string): string {
  // id 用于 URL 与 DB，收敛到安全字符集；目录名天然满足
  return id.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

export function loadWorkspaces(cwd: string): WorkspaceInfo[] {
  const byId = new Map<string, WorkspaceInfo>();
  const put = (id: string, name: string, p: string, isDefault: boolean) => {
    const norm = normalizeId(id);
    if (!norm) return;
    if (isDefault) { byId.set(norm, { id: norm, name, path: path.resolve(p), default: true }); return; }
    if (norm === 'default') return; // 不允许伪装 default
    if (byId.get(norm)?.default) return; // 不覆盖 default
    byId.set(norm, { id: norm, name, path: path.resolve(p), default: false });
  };

  // 1. 启动目录 = default 工作区
  const baseName = path.basename(path.resolve(cwd)) || 'default';
  put('default', baseName, cwd, true);

  // 2. 环境变量（开发/CI 用）：WATER_WORKSPASSES 路径列表
  for (const p of (process.env.WATER_WORKSPACES ?? '').split(path.delimiter)) {
    const t = p.trim();
    if (!t) continue;
    if (!existsSync(t)) { console.warn(`[workspaces] 环境变量中的路径不存在，已跳过: ${t}`); continue; }
    put(path.basename(path.resolve(t)), path.basename(path.resolve(t)), t, false);
  }

  // 3. 用户级注册表 ~/.water/workspaces.json
  const reg = path.join(homedir(), '.water', 'workspaces.json');
  if (existsSync(reg)) {
    try {
      const raw = JSON.parse(readFileSync(reg, 'utf8')) as unknown;
      if (!Array.isArray(raw)) throw new Error('必须是数组');
      for (const [i, e] of raw.entries()) {
        const m = e as RegistryEntry;
        const at = `workspaces.json[${i}]`;
        // 红线扫描：注册表不允许出现凭据字段
        for (const k of Object.keys(m)) {
          if (/key|token|secret/i.test(k)) throw new Error(`${at} 不允许凭据字段: ${k}`);
        }
        if (typeof m.id !== 'string' || !m.id.trim()) throw new Error(`${at} 缺少合法 id`);
        if (typeof m.path !== 'string' || !m.path.trim()) throw new Error(`${at} 缺少合法 path`);
        if (!existsSync(m.path)) { console.warn(`[workspaces] ${at} 路径不存在，已跳过: ${m.path}`); continue; }
        put(m.id, typeof m.name === 'string' && m.name ? m.name : m.id, m.path, false);
      }
    } catch (err) {
      console.error(`[workspaces] 注册表加载失败（忽略该来源）: ${err instanceof Error ? err.message : err}`);
    }
  }

  const list = [...byId.values()];
  console.log(`[workspaces] 已注册 ${list.length} 个工作区: ${list.map(w => `${w.id}(${w.default ? '*' : ''}${w.path})`).join(' · ')}`);
  return list;
}
