/**
 * 配置解析：优先级 命令行 flag > 环境变量 > ~/.water/config.json > 内置默认。
 * 凭据只来自环境变量（由 start-secure DPAPI 注入），config.json 永不存 key。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface WaterConfig {
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  apiKey: string | null;
  apiKeyEnv: string;
  cwd: string;
}

interface FileConfig {
  protocol?: 'anthropic' | 'openai';
  baseUrl?: string;
  model?: string;
}

/** 各协议的默认值 */
const PROTOCOL_DEFAULTS = {
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

export function loadFileConfig(): FileConfig {
  const p = path.join(homedir(), '.water', 'config.json');
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as FileConfig;
    // 红线：config.json 里不允许出现任何 key 字段
    for (const k of Object.keys(j)) {
      if (/key|token|secret/i.test(k)) {
        throw new Error(`config.json 不允许存放凭据字段: ${k}（凭据只走环境变量）`);
      }
    }
    return j;
  } catch (e) {
    throw new Error(`读取 ~/.water/config.json 失败: ${e instanceof Error ? e.message : e}`);
  }
}

export interface CliFlags {
  protocol?: string;
  baseUrl?: string;
  model?: string;
  cwd?: string;
}

export function resolveConfig(flags: CliFlags): WaterConfig {
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
