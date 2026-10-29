import type { WaterConfig } from '../config.js';

/**
 * doctor：环境自检。输出配置摘要 + 连通性探测。
 * 凭据只报告「是否配置」，永不打印值。
 */
export async function cmdDoctor(cfg: WaterConfig): Promise<void> {
  console.log('water doctor · 环境自检\n');

  // 1. Node 版本
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`${major >= 22 ? '✓' : '✗'} Node ${process.versions.node}${major >= 22 ? '' : '（需要 >= 22）'}`);

  // 2. 配置摘要
  console.log(`\n配置（flag > env > ~/.water/config.json > 默认）:`);
  console.log(`  protocol : ${cfg.protocol}`);
  console.log(`  baseUrl  : ${cfg.baseUrl}`);
  console.log(`  model    : ${cfg.model}`);
  console.log(`  工作区   : ${cfg.cwd}`);

  // 3. 凭据
  console.log(`${cfg.apiKey ? '✓' : '✗'} 凭据 ${cfg.apiKeyEnv}: ${cfg.apiKey ? '已注入（长度 ' + cfg.apiKey.length + '）' : '未配置'}`);

  // 4. 连通性探测（不消耗 token：只打 baseUrl 根，看 HTTP 层是否通）
  process.stdout.write(`\n连通性探测 ${cfg.baseUrl} ... `);
  const started = Date.now();
  try {
    const resp = await fetch(cfg.baseUrl, { signal: AbortSignal.timeout(5000) });
    console.log(`HTTP ${resp.status} · ${Date.now() - started}ms（端点可达，状态码非 2xx 也正常——没带鉴权）`);
  } catch (e) {
    console.log(`✗ 不可达: ${e instanceof Error ? e.message : e}`);
  }
}
