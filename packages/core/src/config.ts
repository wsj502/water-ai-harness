/**
 * 配置解析（CLI / Server 共用）：优先级 显式 flag > 环境变量 > ~/.water/config.json > 协议默认。
 * 凭据只来自环境变量（start-secure DPAPI 注入），config.json 永不存 key。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ModelInfo } from './models.js';

export interface WaterConfig {
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  apiKey: string | null;
  apiKeyEnv: string;
  cwd: string;
}

export interface ConfigFlags {
  protocol?: string;
  baseUrl?: string;
  model?: string;
  cwd?: string;
}

/** 自定义模型条目（config.json models[]）：只收元数据，不收凭据 */
interface CustomModelEntry {
  id?: unknown;
  protocol?: unknown;
  label?: unknown;
  vendor?: unknown;
  contextWindow?: unknown;
  thinking?: unknown;
  baseUrl?: unknown;
  apiKeyEnv?: unknown;
}

interface FileConfig {
  protocol?: 'anthropic' | 'openai';
  baseUrl?: string;
  model?: string;
  /** M2：自定义 SYSTEM prompt（env WATER_SYSTEM 优先于此） */
  systemPrompt?: string;
  /** M1：自定义模型表（与内置表合并，id 冲突时自定义优先） */
  models?: ModelInfo[];
}

export const PROTOCOL_DEFAULTS = {
  anthropic: {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-4.6',
    apiKeyEnv: 'ZHIPU_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
} as const;

/** 环境变量名的形状（防误贴真实 key：key 值不会匹配这个模式） */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** 校验并规范化 config.json 里的自定义模型条目；非法即抛错（启动期暴露问题） */
function parseCustomModels(raw: unknown, src: string): ModelInfo[] {
  if (!Array.isArray(raw)) throw new Error(`${src} models 字段必须是数组`);
  return raw.map((e, i) => {
    const m = e as CustomModelEntry;
    const at = `${src} models[${i}]`;
    if (typeof m.id !== 'string' || !m.id.trim()) throw new Error(`${at} 缺少合法 id`);
    if (m.protocol !== 'anthropic' && m.protocol !== 'openai') {
      throw new Error(`${at} protocol 必须是 anthropic | openai`);
    }
    if (m.apiKeyEnv !== undefined && (typeof m.apiKeyEnv !== 'string' || !ENV_NAME_RE.test(m.apiKeyEnv))) {
      throw new Error(`${at} apiKeyEnv 必须是环境变量名（大写字母/数字/下划线），不是 key 本身`);
    }
    if (m.baseUrl !== undefined && typeof m.baseUrl !== 'string') throw new Error(`${at} baseUrl 必须是字符串`);
    return {
      id: m.id.trim(),
      protocol: m.protocol,
      label: typeof m.label === 'string' ? m.label : m.id,
      vendor: typeof m.vendor === 'string' ? m.vendor : '自定义',
      ...(typeof m.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
      ...(m.thinking === true ? { thinking: true } : {}),
      ...(typeof m.baseUrl === 'string' ? { baseUrl: m.baseUrl } : {}),
      ...(typeof m.apiKeyEnv === 'string' ? { apiKeyEnv: m.apiKeyEnv } : {}),
    } satisfies ModelInfo;
  });
}

export function loadFileConfig(): FileConfig {
  const p = path.join(homedir(), '.water', 'config.json');
  if (!existsSync(p)) return {};
  let j: FileConfig & { models?: unknown };
  try {
    j = JSON.parse(readFileSync(p, 'utf8')) as FileConfig & { models?: unknown };
  } catch (e) {
    throw new Error(`读取 ~/.water/config.json 失败: ${e instanceof Error ? e.message : e}`);
  }
  // 红线：config.json 里不允许出现任何 key 字段
  for (const k of Object.keys(j)) {
    if (/key|token|secret/i.test(k)) {
      throw new Error(`config.json 不允许存放凭据字段: ${k}（凭据只走环境变量）`);
    }
  }
  const { models: rawModels, ...rest } = j as FileConfig & { models?: unknown };
  if (rawModels === undefined) return rest;
  return { ...rest, models: parseCustomModels(rawModels, '~/.water/config.json') };
}

export function resolveConfig(flags: ConfigFlags = {}): WaterConfig {
  const file = loadFileConfig();
  const protocol = (flags.protocol ?? process.env.WATER_PROTOCOL ?? file.protocol ?? 'anthropic') as 'anthropic' | 'openai';
  if (protocol !== 'anthropic' && protocol !== 'openai') {
    throw new Error(`未知协议: ${protocol}（可选 anthropic | openai）`);
  }
  const d = PROTOCOL_DEFAULTS[protocol];
  const apiKeyEnv = process.env.WATER_API_KEY_ENV ?? d.apiKeyEnv;
  return {
    protocol,
    baseUrl: flags.baseUrl ?? process.env.WATER_BASE_URL ?? file.baseUrl ?? d.baseUrl,
    model: flags.model ?? process.env.WATER_MODEL ?? file.model ?? d.model,
    apiKey: process.env[apiKeyEnv] ?? null,
    apiKeyEnv,
    cwd: flags.cwd ? path.resolve(flags.cwd) : process.cwd(),
  };
}
