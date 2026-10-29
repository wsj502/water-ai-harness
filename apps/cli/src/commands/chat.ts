import readline from 'node:readline';
import {
  agentLoop, createProvider, builtinTools, PermissionEngine,
  type WMessage, type ToolUsePart,
} from '@water/core';
import type { WaterConfig } from '../config.js';
import { TermRenderer } from '../render.js';

const SYSTEM = [
  '你是 Water，一个工作在当前代码仓库里的 AI 编程助手。',
  '可用工具：read/write/edit/grep/glob/shell。优先小步快跑，改动前先读代码。',
  '回答使用中文，简洁、直接、技术导向。',
].join('\n');

export async function cmdChat(cfg: WaterConfig): Promise<void> {
  if (!cfg.apiKey) {
    console.error(`❌ 缺少凭据 ${cfg.apiKeyEnv}。用 start-secure.ps1 启动以注入 DPAPI 凭据。`);
    process.exit(1);
  }

  const provider = createProvider({ protocol: cfg.protocol, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  const permissions = new PermissionEngine({ autoAllowLowRisk: true });
  const messages: WMessage[] = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(res => rl.question(q, res));

  const approve = async (call: ToolUsePart, reason: string) => {
    console.log(`\n\x1b[33m⚠ 审批请求：${call.name}(${reason})\x1b[0m`);
    console.log(`  参数: ${JSON.stringify(call.input).slice(0, 200)}`);
    const a = (await ask('  [⏎]允许一次  [a]本会话总是允许  [其他]拒绝: ')).trim().toLowerCase();
    return a === '' ? 'once' as const : a === 'a' ? 'session' as const : 'deny' as const;
  };

  console.log(`\x1b[36mwater chat\x1b[0m · ${cfg.model} via ${cfg.protocol} · 工作区 ${cfg.cwd}`);
  console.log('输入消息开始，Ctrl+C 退出。\n');

  for (;;) {
    const input = (await ask('\x1b[32m你 >\x1b[0m ')).trim();
    if (!input) continue;
    if (input === '/exit' || input === '/quit') break;

    messages.push({ role: 'user', parts: [{ type: 'text', text: input }] });
    process.stdout.write('\x1b[34mwater >\x1b[0m ');

    const renderer = new TermRenderer();
    for await (const ev of agentLoop({
      provider, model: cfg.model, system: SYSTEM, messages,
      tools: builtinTools, permissions,
      toolCtx: { cwd: cfg.cwd }, approve, maxTurns: 12,
    })) {
      renderer.handle(ev);
    }
  }
  rl.close();
}
