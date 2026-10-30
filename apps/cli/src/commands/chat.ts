import readline from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  agentLoop, createProvider, builtinTools, PermissionEngine, MockProvider,
  BUILTIN_MODELS, mergeModels, loadFileConfig, findModel, compactMessages, estimateMessagesTokens,
  PROTOCOL_DEFAULTS, PROTOCOL_LABEL,
  type Provider, type WMessage, type ToolUsePart,
} from '@water/core';
import type { WaterConfig } from '../config.js';
import { TermRenderer } from '../render.js';

const SYSTEM_BASE = [
  '你是 Water，一个工作在当前代码仓库里的 AI 编程助手。',
  '可用工具：read/write/edit/grep/glob/shell/task。优先小步快跑，改动前先读代码；调研类子任务可派生只读子代理。',
  '回答使用中文，简洁、直接、技术导向。',
].join('\n');

export async function cmdChat(cfg: WaterConfig): Promise<void> {
  const mock = process.env.WATER_MOCK === '1';
  if (!mock && !cfg.apiKey) {
    console.error(`❌ 缺少凭据 ${cfg.apiKeyEnv}。用 start-secure.ps1 启动以注入 DPAPI 凭据，或 WATER_MOCK=1 离线体验。`);
    process.exit(1);
  }

  // M10：可切换的运行时模型状态（注册表 = 内置 + config.json 自定义）
  const fileCfg = loadFileConfig();
  const registry = mergeModels(BUILTIN_MODELS, fileCfg.models ?? []);
  let model = cfg.model;
  let protocol = cfg.protocol;
  const apiKeyOf = (envName: string): string | null => process.env[envName] ?? null;
  const baseUrlOf = (p: 'anthropic' | 'openai'): string =>
    process.env.WATER_BASE_URL ?? fileCfg.baseUrl ?? PROTOCOL_DEFAULTS[p].baseUrl;

  const buildProvider = (): Provider => mock
    ? new MockProvider()
    : createProvider({ protocol, baseUrl: baseUrlOf(protocol), apiKey: apiKeyOf(PROTOCOL_DEFAULTS[protocol].apiKeyEnv) ?? cfg.apiKey! });
  let provider = buildProvider();

  // M10：工作区 AGENTS.md 拼接（与 server 行为一致）
  const agentsPath = path.join(cfg.cwd, 'AGENTS.md');
  const agentsMd = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8').slice(0, 8000) : null;
  const SYSTEM = agentsMd ? `${SYSTEM_BASE}\n\n# 项目上下文（工作区 AGENTS.md）\n${agentsMd}` : SYSTEM_BASE;

  const permissions = new PermissionEngine({ autoAllowLowRisk: true });
  const messages: WMessage[] = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 事件驱动的 ask：缓存两次 question 之间到达的行——管道/文件 stdin 不丢输入（可脚本化测试）
  const pendingLines: string[] = [];
  let lineResolver: ((s: string) => void) | null = null;
  rl.on('line', line => {
    if (lineResolver) { const r = lineResolver; lineResolver = null; r(line); }
    else pendingLines.push(line);
  });
  const ask = (q: string): Promise<string> => new Promise(res => {
    process.stdout.write(q);
    const next = pendingLines.shift();
    if (next !== undefined) res(next);
    else lineResolver = res;
  });

  const approve = async (call: ToolUsePart, reason: string) => {
    console.log(`\n\x1b[33m⚠ 审批请求：${call.name}(${reason})\x1b[0m`);
    console.log(`  参数: ${JSON.stringify(call.input).slice(0, 200)}`);
    const a = (await ask('  [⏎]允许一次  [a]本会话总是允许  [其他]拒绝: ')).trim().toLowerCase();
    return a === '' ? 'once' as const : a === 'a' ? 'session' as const : 'deny' as const;
  };

  // ---- M10 内置命令 ----
  const showHelp = (): void => {
    console.log([
      '命令：',
      '  /model          列出可用模型（注册表 = 内置 + ~/.water/config.json models[]）',
      '  /model <id>     切换本会话模型（协议随模型，下一条消息生效）',
      '  /compact        立即压缩上下文（预算 = 模型窗口 × 0.8）',
      '  /system         查看生效 SYSTEM（含工作区 AGENTS.md）',
      '  /help           本清单      /exit 退出',
    ].join('\n'));
  };

  const listModels = (): void => {
    console.log(`当前：${model}（${protocol}）\n可用模型：`);
    for (const m of registry) {
      const envName = m.apiKeyEnv ?? PROTOCOL_DEFAULTS[m.protocol].apiKeyEnv;
      const ready = mock || apiKeyOf(envName) !== null;
      console.log(`  ${m.id === model ? '←' : ' '} ${m.id} [${PROTOCOL_LABEL[m.protocol]}]${ready ? '' : `（缺凭据 ${envName}）`}`);
    }
  };

  const switchModel = (id: string): void => {
    const info = findModel(registry, id);
    if (!info) { console.log(`未知模型 ${id}（/model 查看清单）`); return; }
    const envName = info.apiKeyEnv ?? PROTOCOL_DEFAULTS[info.protocol].apiKeyEnv;
    if (!mock && !apiKeyOf(envName)) { console.log(`⛔ ${info.id} 缺少凭据 ${envName}，未切换`); return; }
    model = info.id;
    protocol = info.protocol;
    provider = buildProvider();
    console.log(`✅ 已切换 → ${model}（${protocol}），下一条消息生效`);
  };

  const compactNow = (): void => {
    const forced = Number(process.env.WATER_MAX_CONTEXT_TOKENS) || 0;
    const info = findModel(registry, model);
    const budget = forced > 0 ? forced : (info?.contextWindow ? Math.floor(info.contextWindow * 0.8) : undefined);
    if (budget === undefined) { console.log('当前模型无窗口信息，无法确定预算'); return; }
    const r = compactMessages(messages, budget);
    console.log(r.compacted
      ? `🗜 已压缩：${r.estBefore} → ${r.estAfter} token（丢弃 ${r.droppedMessages} 条，截断 ${r.truncatedResults} 条工具结果）`
      : `无需压缩（估算 ${estimateMessagesTokens(messages)} ≤ 预算 ${budget}）`);
  };

  const showSystem = (): void => {
    console.log(`生效 SYSTEM（${SYSTEM.length} 字符${agentsMd ? '，含工作区 AGENTS.md' : ''}，前 400 字）：\n${SYSTEM.slice(0, 400)}${SYSTEM.length > 400 ? '\n…' : ''}`);
  };

  console.log(`\x1b[36mwater chat\x1b[0m · ${model} via ${mock ? 'mock' : protocol} · 工作区 ${cfg.cwd}`);
  console.log('输入消息开始；/help 查看命令；Ctrl+C 退出。\n');

  for (;;) {
    const input = (await ask('\x1b[32m你 >\x1b[0m ')).trim();
    if (!input) continue;
    if (input === '/exit' || input === '/quit') break;

    // 内置命令（M10）：本地处理，不进模型
    if (input.startsWith('/')) {
      const m = input.match(/^\/(\S+)\s*(.*)$/)!;
      const cmd = m[1]!, arg = m[2]!.trim();
      if (cmd === 'help') { showHelp(); continue; }
      if (cmd === 'model') { arg ? switchModel(arg) : listModels(); continue; }
      if (cmd === 'compact') { compactNow(); continue; }
      if (cmd === 'system') { showSystem(); continue; }
      console.log(`未知命令 /${cmd}（/help 查看清单）——已拦截，未发送给模型`);
      continue;
    }

    messages.push({ role: 'user', parts: [{ type: 'text', text: input }] });
    process.stdout.write('\x1b[34mwater >\x1b[0m ');

    const renderer = new TermRenderer();
    for await (const ev of agentLoop({
      provider, model, system: SYSTEM, messages,
      tools: builtinTools, permissions,
      toolCtx: { cwd: cfg.cwd }, approve, maxTurns: 12,
    })) {
      renderer.handle(ev);
    }
  }
  rl.close();
}
