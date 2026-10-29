import type { Provider, ProviderConfig } from '../types.js';
import { PROTOCOL_DEFAULTS } from '../config.js';
import type { ModelInfo, WireProtocol } from '../models.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';

/** 按配置创建 Provider 适配器 —— 内核唯一的入口 */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.protocol) {
    case 'anthropic': return new AnthropicProvider(config);
    case 'openai': return new OpenAIProvider(config);
  }
}

// ---------- Provider Registry（M1）----------

/** Registry 对宿主环境的两个依赖（注入而非直连 process.env，便于测试） */
export interface ProviderRegistryEnv {
  /** 某协议的默认 baseUrl（配置链：env > ~/.water/config.json > 协议内置默认） */
  baseUrlOf(protocol: WireProtocol): string;
  /** 按环境变量名读凭据（start-secure 注入 / CI secrets）；未配置返回 null */
  apiKeyOf(envName: string): string | null;
}

export type AcquireResult =
  | { ok: true; provider: Provider }
  | { ok: false; error: string };

/**
 * 模型注册表：模型元数据 → 可用 Provider 实例。
 *
 * 适配器是无状态的（配置只在构造时读取），因此按
 * (protocol, baseUrl, apiKeyEnv) 缓存实例，多会话共享同一适配器。
 *
 * 为什么 Web 不能随意指定 baseUrl：凭据在服务端，若允许浏览器
 * 传入任意 baseUrl，等于把 key 转发给任意地址（key 外泄通道）。
 * 因此 baseUrl 只能来自服务端配置文件/环境变量，Web 只能「选模型」。
 */
export class ProviderRegistry {
  private byId = new Map<string, ModelInfo>();
  private cache = new Map<string, Provider>();

  constructor(models: ModelInfo[], private env: ProviderRegistryEnv) {
    for (const m of models) this.byId.set(m.id.toLowerCase(), m);
  }

  list(): ModelInfo[] { return [...this.byId.values()]; }

  find(id: string): ModelInfo | undefined {
    return this.byId.get(id.toLowerCase());
  }

  /** 取（或建）模型对应的 Provider；凭据缺失时返回带指引的错误 */
  acquire(info: ModelInfo): AcquireResult {
    const baseUrl = info.baseUrl ?? this.env.baseUrlOf(info.protocol);
    const envName = info.apiKeyEnv ?? PROTOCOL_DEFAULTS[info.protocol].apiKeyEnv;
    const apiKey = this.env.apiKeyOf(envName);
    if (!apiKey) {
      return {
        ok: false,
        error: `模型 ${info.id} 缺少凭据：请设置环境变量 ${envName}（本地用 start-secure 注入）后重试`,
      };
    }
    const cacheKey = `${info.protocol}|${baseUrl}|${envName}`;
    let p = this.cache.get(cacheKey);
    if (!p) {
      p = createProvider({ protocol: info.protocol, baseUrl, apiKey });
      this.cache.set(cacheKey, p);
    }
    return { ok: true, provider: p };
  }
}
