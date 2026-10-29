/**
 * 模型注册表（M1）：模型元数据的单一事实源。
 *
 * 解决的问题：0.1.0 时代「模型 = server 启动时的一个全局字符串」，
 * Web 只能看不能选。现在模型成为一等公民：每个模型有协议、厂商、
 * 上下文窗口、能力标记，/api/models 与会话级切换都从这里取数。
 *
 * 凭据红线：这里只有元数据。apiKeyEnv 存的是环境变量的「名字」，
 * 永远不是 key 本身；key 仍然只经 start-secure 注入进程内存。
 *
 * 扩展方式：~/.water/config.json 的 models[] 数组可追加自定义模型
 * （自建 vLLM / 内网网关等），与内置表合并，id 冲突时自定义优先。
 */
import type { ProviderConfig } from './types.js';

export type WireProtocol = ProviderConfig['protocol'];

export interface ModelInfo {
  /** 模型 id：发给 API 的名字，也是注册表主键 */
  id: string;
  protocol: WireProtocol;
  /** 展示名（中文备注） */
  label: string;
  /** 厂商 / 来源 */
  vendor: string;
  /** 上下文窗口（token），用于 UI 提示与后续上下文预算；未知省略 */
  contextWindow?: number;
  /** 推理模型（思考通道）标记 */
  thinking?: boolean;
  /** 自定义模型可指定 baseUrl；内置模型用协议默认 */
  baseUrl?: string;
  /** 自定义模型可指定凭据环境变量名（缺省用协议默认名） */
  apiKeyEnv?: string;
}

/**
 * 内置模型表。上下文窗口以各厂商公开文档为准（2026-10），
 * 仅作预算估算展示，不追求精确计费。
 */
export const BUILTIN_MODELS: ModelInfo[] = [
  {
    id: 'glm-4.6', protocol: 'anthropic', label: 'GLM-4.6', vendor: '智谱',
    contextWindow: 200_000, thinking: true,
  },
  {
    id: 'glm-4.5-air', protocol: 'anthropic', label: 'GLM-4.5-Air', vendor: '智谱',
    contextWindow: 128_000,
  },
  {
    id: 'deepseek-chat', protocol: 'openai', label: 'DeepSeek Chat', vendor: 'DeepSeek',
    contextWindow: 128_000,
  },
  {
    id: 'deepseek-reasoner', protocol: 'openai', label: 'DeepSeek Reasoner', vendor: 'DeepSeek',
    contextWindow: 128_000, thinking: true,
  },
];

/** 协议展示名（Web 分组菜单用） */
export const PROTOCOL_LABEL: Record<WireProtocol, string> = {
  anthropic: 'Anthropic Messages',
  openai: 'OpenAI 兼容',
};

/** 合并内置表与用户自定义表（id 冲突时自定义优先） */
export function mergeModels(builtin: ModelInfo[], custom: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const m of builtin) byId.set(m.id, m);
  for (const m of custom) byId.set(m.id, m);
  return [...byId.values()];
}

/** 按 id 查找（大小写不敏感：模型 id 惯例小写，但容错用户输入） */
export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  const lower = id.toLowerCase();
  return models.find(m => m.id.toLowerCase() === lower);
}
