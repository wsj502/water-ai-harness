/**
 * ProviderRegistry 单测（M4）：查找/凭据缺失/实例缓存复用。
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODELS, mergeModels, ProviderRegistry, findModel } from '../packages/core/src/index.js';

describe('模型注册表数据', () => {
  it('内置表含双协议默认模型', () => {
    expect(BUILTIN_MODELS.some(m => m.id === 'glm-4.6' && m.protocol === 'anthropic')).toBe(true);
    expect(BUILTIN_MODELS.some(m => m.id === 'deepseek-chat' && m.protocol === 'openai')).toBe(true);
  });
  it('mergeModels：id 冲突自定义优先；findModel 大小写不敏感', () => {
    const custom = [{ id: 'glm-4.6', protocol: 'anthropic' as const, label: '内网镜像', vendor: '自定义', baseUrl: 'http://10.0.0.1' }];
    const merged = mergeModels(BUILTIN_MODELS, custom);
    expect(merged.find(m => m.id === 'glm-4.6')!.baseUrl).toBe('http://10.0.0.1');
    expect(findModel(merged, 'GLM-4.6')!.label).toBe('内网镜像');
  });
});

describe('ProviderRegistry', () => {
  function makeRegistry(env: { keys: Record<string, string> }, baseUrl = 'https://api.test') {
    return new ProviderRegistry(mergeModels(BUILTIN_MODELS, [{
      id: 'my-vllm', protocol: 'openai', label: 'vLLM', vendor: '自定义',
      baseUrl: 'http://10.0.0.2/v1', apiKeyEnv: 'VLLM_KEY',
    }]), {
      baseUrlOf: () => baseUrl,
      apiKeyOf: name => env.keys[name] ?? null,
    });
  }

  it('find 命中内置与自定义模型', () => {
    const r = makeRegistry({ keys: {} });
    expect(r.find('glm-4.6')!.id).toBe('glm-4.6');
    expect(r.find('my-vllm')!.apiKeyEnv).toBe('VLLM_KEY');
    expect(r.find('nope')).toBeUndefined();
  });

  it('acquire：缺凭据返回带指引的错误', () => {
    const r = makeRegistry({ keys: {} });
    const res = r.acquire(r.find('glm-4.6')!);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('ZHIPU_API_KEY');
  });

  it('acquire：有凭据返回 provider，且同参数复用缓存实例', () => {
    const r = makeRegistry({ keys: { ZHIPU_API_KEY: 'k', VLLM_KEY: 'v' } });
    const a = r.acquire(r.find('glm-4.6')!);
    const b = r.acquire(r.find('glm-4.5-air')!); // 同协议同 baseUrl 同 env → 同实例
    const c = r.acquire(r.find('my-vllm')!);     // 不同 baseUrl → 新实例
    expect(a.ok && b.ok && a.provider === b.provider).toBe(true);
    expect(a.ok && c.ok && a.provider !== c.provider).toBe(true);
    expect(a.ok && a.provider.protocol).toBe('anthropic');
    expect(c.ok && c.provider.protocol).toBe('openai');
  });

  it('list 返回合并后全表', () => {
    const r = makeRegistry({ keys: {} });
    expect(r.list().some(m => m.id === 'my-vllm')).toBe(true);
  });
});
