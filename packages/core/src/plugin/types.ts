/**
 * 插件 API 契约（P5）。
 *
 * 设计取舍（详见文章 07）：
 * - 进程内 ESM 插件：开发体验好、性能零损耗；代价是无法运行时沙箱
 * - 权限声明 = 治理契约（安装前可见、高权限工具强制审批），不是运行时隔离
 * - 需要真隔离的能力走 MCP 桥接（进程外），见 plugins/mcp-bridge
 */

import type { Tool } from '../tools/index.js';

// ---------- 清单：water-plugin.json ----------

export interface PluginManifest {
  name: string;                    // 包名，如 water-plugin-echo
  version: string;
  description?: string;
  /** 入口 ESM 文件，相对插件目录，如 dist/index.js 或 index.js */
  main: string;
  /** 声明的权限（安装前向用户展示）：network / shell / fs:read / fs:write / process:spawn */
  permissions?: string[];
  engines?: { water?: string };
}

// ---------- 斜杠命令 ----------

export interface SlashCommand {
  /** 命令名（不含 /），如 "review" */
  name: string;
  description: string;
  /** 提示词模板，$ARGUMENTS 会被用户输入替换 */
  template: string;
}

// ---------- 钩子 ----------

export interface PluginHooks {
  /** 工具执行前；返回 false 可阻止执行 */
  beforeToolCall?(toolName: string, input: Record<string, unknown>): boolean | void;
  afterToolCall?(toolName: string, ok: boolean, durationMs: number): void;
}

// ---------- 插件模块契约 ----------

export interface PluginContext {
  /** 注册新工具（进入 Agent Loop 的工具表，受权限引擎管辖） */
  registerTool(tool: Tool): void;
  registerCommand(cmd: SlashCommand): void;
  registerHooks(hooks: PluginHooks): void;
  /** 插件目录绝对路径（读插件自带资源用） */
  pluginDir: string;
  /** 工作区根目录 */
  cwd: string;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ---------- 注册表（加载器的产出） ----------

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  tools: Tool[];
  commands: SlashCommand[];
  hooks: PluginHooks[];
  error?: string;
}

export interface PluginRegistry {
  plugins: LoadedPlugin[];
  tools: Tool[];
  commands: SlashCommand[];
  hooks: PluginHooks[];
}
