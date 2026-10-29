/**
 * P1 冒烟测试：终端里跑通 Agent Loop 的最小外壳（CLI 的雏形）。
 *
 * 用法（凭据通过 DPAPI 注入，见 README）：
 *   powershell -ExecutionPolicy Bypass -File .\start-secure.ps1 -- npx tsx scripts/dev-chat.ts
 *
 * 环境变量：
 *   ZHIPU_API_KEY      智谱 key（必需）
 *   WATER_MODEL        缺省 glm-4.6
 *   WATER_PROTOCOL     anthropic | openai（缺省 anthropic）
 *   WATER_BASE_URL     缺省 https://open.bigmodel.cn/api/anthropic
 */
import readline from 'node:readline';
import process from 'node:process';
import {
  agentLoop, createProvider, builtinTools, PermissionEngine,
  type WMessage, type ToolUsePart,
} from '../packages/core/src/index.js';

const apiKey = process.env.ZHIPU_API_KEY;
if (!apiKey) {
  console.error('❌ 缺少 ZHIPU_API_KEY。请先 import-secrets 导入，再用 start-secure 启动本脚本。');
  console.error('   import-secrets.ps1 -Path <你的.env>   # .env 里写 ZHIPU_API_KEY=xxx');
  process.exit(1);
}

const provider = createProvider({
  protocol: (process.env.WATER_PROTOCOL as 'anthropic' | 'openai') ?? 'anthropic',
  baseUrl: process.env.WATER_BASE_URL ?? 'https://open.bigmodel.cn/api/anthropic',
  apiKey,
});
const model = process.env.WATER_MODEL ?? 'glm-4.6';

const permissions = new PermissionEngine({ autoAllowLowRisk: true });
const messages: WMessage[] = [];
const cwd = process.cwd();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(res => rl.question(q, res));

const SYSTEM = [
  '你是 Water，一个工作在当前代码仓库里的 AI 编程助手。',
  '可用工具：read/write/edit/grep/glob/shell。优先小步快跑，改动前先读代码。',
  '回答使用中文，简洁、直接、技术导向。',
].join('\n');

async function approve(call: ToolUsePart, reason: string): Promise<'once' | 'session' | 'deny'> {
  console.log(`\n\x1b[33m⚠ 审批请求：${call.name}(${reason})\x1b[0m`);
  console.log(`  参数: ${JSON.stringify(call.input).slice(0, 200)}`);
  const a = (await ask('  [⏎]允许一次  [a]本会话总是允许  [esc/其他]拒绝: ')).trim().toLowerCase();
  if (a === '') return 'once';
  if (a === 'a') return 'session';
  return 'deny';
}

async function main() {
  console.log(`\x1b[36mWater P1 冒烟 · ${model} via ${provider.protocol}\x1b[0m  工作区: ${cwd}`);
  console.log('输入消息开始，Ctrl+C 退出。\n');

  for (;;) {
    const input = (await ask('\x1b[32m你 >\x1b[0m ')).trim();
    if (!input) continue;
    messages.push({ role: 'user', parts: [{ type: 'text', text: input }] });

    let inThink = false;
    process.stdout.write('\x1b[34mWater >\x1b[0m ');

    for await (const ev of agentLoop({
      provider, model, system: SYSTEM, messages,
      tools: builtinTools, permissions,
      toolCtx: { cwd }, approve, maxTurns: 12,
    })) {
      switch (ev.type) {
        case 'thinking_delta':
          if (!inThink) { process.stdout.write('\x1b[35m💭 '); inThink = true; }
          process.stdout.write(ev.text);
          break;
        case 'text_delta':
          if (inThink) { process.stdout.write('\x1b[0m\n'); inThink = false; }
          process.stdout.write(ev.text);
          break;
        case 'tool_pending':
          console.log(`\n\x1b[36m⚙ ${ev.call.name}\x1b[0m ${JSON.stringify(ev.call.input).slice(0, 120)}`);
          break;
        case 'tool_result':
          console.log(`  \x1b[${ev.isError ? 31 : 90}m${ev.isError ? '✗' : '✓'} ${ev.durationMs}ms ` +
            `${ev.result.slice(0, 160).replace(/\n/g, ' ⏎ ')}\x1b[0m`);
          break;
        case 'tool_denied':
          console.log('  \x1b[31m✗ 已拒绝\x1b[0m');
          break;
        case 'turn_start':
          if (ev.turn > 1) process.stdout.write(`\n\x1b[90m--- 第 ${ev.turn} 轮 ---\x1b[0m\n`);
          break;
        case 'usage':
          console.log(`\x1b[90m[tokens: in=${ev.inputTokens} out=${ev.outputTokens}]\x1b[0m`);
          break;
        case 'finish':
          console.log(`\n\x1b[90m--- 结束: ${ev.reason}${ev.message ? ' · ' + ev.message : ''} ---\x1b[0m\n`);
          break;
      }
    }
    if (inThink) process.stdout.write('\x1b[0m');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
