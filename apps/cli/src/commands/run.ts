import {
  agentLoop, createProvider, builtinTools, PermissionEngine, MockProvider,
  type WMessage,
} from '@water/core';
import type { WaterConfig } from '../config.js';
import { TermRenderer, emitNdjson } from '../render.js';

const SYSTEM = [
  '你是 Water，一个工作在当前代码仓库里的 AI 编程助手。',
  '这是一次非交互任务：直接给出结论或完成改动，不要向用户提问。',
  '可用工具：read/write/edit/grep/glob/shell。回答使用中文，简洁、技术导向。',
].join('\n');

export interface RunOptions {
  json?: boolean;
  yes?: boolean;      // --yes：自动批准所有审批（危险，仅限信任任务）
  maxTurns?: number;
}

export async function cmdRun(task: string, cfg: WaterConfig, opts: RunOptions): Promise<void> {
  const mock = process.env.WATER_MOCK === '1';
  if (!mock && !cfg.apiKey) {
    console.error(`❌ 缺少凭据 ${cfg.apiKeyEnv}。用 start-secure.ps1 启动以注入 DPAPI 凭据，或 WATER_MOCK=1 离线体验。`);
    process.exit(1);
  }
  if (opts.yes && !opts.json) {
    console.error('\x1b[33m⚠ --yes 已开启：所有工具调用将自动批准，请确认任务可信。\x1b[0m');
  }

  const provider = process.env.WATER_MOCK === '1'
    ? new MockProvider()
    : createProvider({ protocol: cfg.protocol, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey! });
  const permissions = new PermissionEngine({ autoAllowLowRisk: true });
  const messages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: task }] }];

  // 非交互模式：--yes 自动批准；否则审批请求一律拒绝（无人可问）
  const approve = opts.yes ? async () => 'once' as const : undefined;

  const renderer = new TermRenderer();
  if (!opts.json) {
    console.log(`\x1b[36mwater run\x1b[0m · ${cfg.model} via ${cfg.protocol} · ${cfg.cwd}\n`);
  }

  let exitCode = 0;
  for await (const ev of agentLoop({
    provider, model: cfg.model, system: SYSTEM, messages,
    tools: builtinTools, permissions,
    toolCtx: { cwd: cfg.cwd },
    ...(approve ? { approve } : {}),
    maxTurns: opts.maxTurns ?? 20,
  })) {
    if (opts.json) emitNdjson(ev);
    else renderer.handle(ev);
    if (ev.type === 'finish' && ev.reason === 'error') exitCode = 1;
  }
  process.exit(exitCode);
}
