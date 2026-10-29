import type { Provider, ProviderConfig } from '../types.js';
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
