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
  /** M13：配置式斜杠命令（零代码插件——只是 prompt 模板，无执行逻辑） */
  commands?: ConfigCommand[];
  /** M17/M22：配置式声明工具（prompt 型 = 模板 $参数 替换；http 型 = 声明式出网调用） */
  tools?: ConfigTool[];
  /** M22：http 型工具的域名白名单（防 SSRF）——http 工具的 url host 必须在此列 */
  allowedHttpHosts?: string[];
}

/** 配置式命令：模板中 $ARGUMENTS 替换为用户参数 */
export interface ConfigCommand {
  name: string;
  template: string;
  description?: string;
}

/** 配置式声明工具的 http 形状（M22）：url/headers/body 支持 `$参数` 与 `$env:变量名` 插值 */
export interface ConfigToolHttp {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** 配置式声明工具：parameters 为 JSON Schema（原样透传给模型）；执行语义见 kind（M17 定案 prompt / M22 增补 http） */
export interface ConfigTool {
  name: string;
  description: string;
  kind?: 'prompt' | 'http';
  /** prompt 型必填：模板中 $参数名 替换为入参 */
  template?: string;
  /** http 型必填：声明式出网调用（域名白名单 + 凭据只走 $env: 插值） */
  http?: ConfigToolHttp;
  parameters?: Record<string, unknown>;
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

/** 命令名形状（防注入路径/空格：仅字母数字连字符） */
const COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 校验配置式命令条目；非法即抛错（启动期暴露） */
function parseConfigCommands(raw: unknown, src: string): ConfigCommand[] {
  if (!Array.isArray(raw)) throw new Error(`${src} commands 字段必须是数组`);
  return raw.map((e, i) => {
    const at = `${src} commands[${i}]`;
    if (typeof e !== 'object' || e === null) throw new Error(`${at} 必须是对象`);
    for (const k of Object.keys(e as Record<string, unknown>)) {
      if (k !== 'name' && k !== 'template' && k !== 'description') {
        throw new Error(`${at} 不支持的字段: ${k}（仅 name/template/description）`);
      }
    }
    const c = e as { name?: unknown; template?: unknown };
    if (typeof c.name !== 'string' || !COMMAND_NAME_RE.test(c.name)) {
      throw new Error(`${at} name 必须是字母开头的字母/数字/连字符`);
    }
    if (typeof c.template !== 'string' || !c.template.trim()) throw new Error(`${at} template 必须是非空字符串`);
    return {
      name: c.name,
      template: c.template,
      ...(typeof (e as { description?: unknown }).description === 'string'
        ? { description: (e as { description: string }).description } : {}),
    };
  });
}

/** 校验配置式声明工具条目；非法即抛错（启动期暴露）。字段白名单——无任何执行体字段（prompt/http 双 kind，M22） */
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

function parseConfigTools(raw: unknown, src: string): ConfigTool[] {
  if (!Array.isArray(raw)) throw new Error(`${src} tools 字段必须是数组`);
  return raw.map((e, i) => {
    const at = `${src} tools[${i}]`;
    if (typeof e !== 'object' || e === null) throw new Error(`${at} 必须是对象`);
    for (const k of Object.keys(e as Record<string, unknown>)) {
      if (k !== 'name' && k !== 'description' && k !== 'template' && k !== 'parameters' && k !== 'kind' && k !== 'http') {
        throw new Error(`${at} 不支持的字段: ${k}（仅 name/description/kind/template/http/parameters——无执行体，防夹带）`);
      }
    }
    const t = e as { name?: unknown; description?: unknown; template?: unknown; parameters?: unknown; kind?: unknown; http?: unknown };
    if (typeof t.name !== 'string' || !COMMAND_NAME_RE.test(t.name)) {
      throw new Error(`${at} name 必须是字母开头的字母/数字/连字符`);
    }
    if (typeof t.description !== 'string' || !t.description.trim()) {
      throw new Error(`${at} description 必填非空（模型靠它判断何时调用该工具）`);
    }
    let kind: 'prompt' | 'http';
    if (t.kind === undefined || t.kind === 'prompt') kind = 'prompt';
    else if (t.kind === 'http') kind = 'http';
    else throw new Error(`${at} kind 必须是 prompt | http（缺省 prompt）`);
    let http: ConfigToolHttp | undefined;
    if (kind === 'prompt') {
      if (typeof t.template !== 'string' || !t.template.trim()) throw new Error(`${at} prompt 型工具 template 必填且非空`);
    } else {
      if (t.template !== undefined) throw new Error(`${at} http 型工具不支持 template（请求体用 http.body 携带）`);
      const h = t.http;
      if (typeof h !== 'object' || h === null || Array.isArray(h)) {
        throw new Error(`${at} http 型工具必须声明 http: { url, method?, headers?, body? }`);
      }
      const hh = h as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
      let u: URL;
      try { u = new URL(String(hh.url ?? '')); } catch { throw new Error(`${at} http.url 必须是合法的绝对 URL`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${at} http.url 仅支持 http/https`);
      if (hh.method !== undefined && (typeof hh.method !== 'string' || !HTTP_METHODS.has(hh.method.toUpperCase()))) {
        throw new Error(`${at} http.method 必须是 ${[...HTTP_METHODS].join('/')} 之一`);
      }
      if (hh.headers !== undefined) {
        if (typeof hh.headers !== 'object' || hh.headers === null || Array.isArray(hh.headers)) {
          throw new Error(`${at} http.headers 必须是对象`);
        }
        for (const v of Object.values(hh.headers as Record<string, unknown>)) {
          if (typeof v !== 'string') throw new Error(`${at} http.headers 的值必须是字符串（支持 $env:变量 与 $参数 插值）`);
        }
      }
      if (hh.body !== undefined && typeof hh.body !== 'string') throw new Error(`${at} http.body 必须是字符串`);
      http = {
        url: hh.url as string,
        ...(hh.method !== undefined ? { method: (hh.method as string).toUpperCase() } : {}),
        ...(hh.headers !== undefined ? { headers: hh.headers as Record<string, string> } : {}),
        ...(hh.body !== undefined ? { body: hh.body as string } : {}),
      };
    }
    if (t.parameters !== undefined && (typeof t.parameters !== 'object' || t.parameters === null)) {
      throw new Error(`${at} parameters 必须是 JSON Schema 对象`);
    }
    return {
      name: t.name,
      description: t.description,
      kind,
      ...(kind === 'prompt' ? { template: t.template as string } : {}),
      ...(http !== undefined ? { http } : {}),
      ...(t.parameters !== undefined ? { parameters: t.parameters as Record<string, unknown> } : {}),
    };
  });
}

/** M22：解析域名白名单（主机名，可含端口） */
function parseAllowedHttpHosts(raw: unknown, src: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${src} allowedHttpHosts 必须是字符串数组`);
  return raw.map(h => {
    if (typeof h !== 'string' || !/^[A-Za-z0-9.\-\[\]:_]+$/.test(h) || !h.trim()) {
      throw new Error(`${src} allowedHttpHosts 条目必须是主机名（可含端口），收到: ${String(h)}`);
    }
    return h.trim();
  });
}

export function loadFileConfig(): FileConfig {
  // WATER_CONFIG_FILE：测试/多环境注入配置路径（缺省 ~/.water/config.json）
  const p = process.env.WATER_CONFIG_FILE ?? path.join(homedir(), '.water', 'config.json');
  if (!existsSync(p)) return {};
  let j: FileConfig & { models?: unknown; commands?: unknown; tools?: unknown };
  try {
    j = JSON.parse(readFileSync(p, 'utf8')) as FileConfig & { models?: unknown; commands?: unknown; tools?: unknown };
  } catch (e) {
    throw new Error(`读取 ${p} 失败: ${e instanceof Error ? e.message : e}`);
  }
  // 红线：config.json 里不允许出现任何 key 字段
  for (const k of Object.keys(j)) {
    if (/key|token|secret/i.test(k)) {
      throw new Error(`config.json 不允许存放凭据字段: ${k}（凭据只走环境变量）`);
    }
  }
  const models = j.models === undefined ? undefined : parseCustomModels(j.models, '~/.water/config.json');
  const commands = j.commands === undefined ? undefined : parseConfigCommands(j.commands, '~/.water/config.json');
  const tools = j.tools === undefined ? undefined : parseConfigTools(j.tools, '~/.water/config.json');
  const allowedHttpHosts = j.allowedHttpHosts === undefined ? undefined
    : parseAllowedHttpHosts(j.allowedHttpHosts, '~/.water/config.json');
  // M22：http 工具的 url host 必须在白名单（防 SSRF）——启动期校验，绝不裸放行
  if (tools && tools.some(t => t.kind === 'http')) {
    if (!allowedHttpHosts?.length) {
      throw new Error('~/.water/config.json 存在 http 型工具但未配置 allowedHttpHosts 白名单（防 SSRF，必填）');
    }
    for (const t of tools) {
      if (t.kind !== 'http' || !t.http) continue;
      const u = new URL(t.http.url);
      if (!allowedHttpHosts.includes(u.host) && !allowedHttpHosts.includes(u.hostname)) {
        throw new Error(`~/.water/config.json tools[${t.name}] 的 url host "${u.host}" 不在 allowedHttpHosts 白名单（防 SSRF）`);
      }
    }
  }
  const { models: _m, commands: _c, tools: _t, allowedHttpHosts: _h, ...rest } = j as FileConfig & { models?: unknown; commands?: unknown; tools?: unknown; allowedHttpHosts?: unknown };
  if (models === undefined && commands === undefined && tools === undefined && allowedHttpHosts === undefined) return rest;
  return {
    ...rest,
    ...(models !== undefined ? { models } : {}),
    ...(commands !== undefined ? { commands } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(allowedHttpHosts !== undefined ? { allowedHttpHosts } : {}),
  };
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
