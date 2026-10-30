#!/usr/bin/env node
/**
 * water CLI 入口：命令树定义。
 *
 *   water chat                     交互式会话
 *   water run "<task>" [--json]    一次性任务（--json 输出 NDJSON 事件流）
 *   water doctor                   环境自检
 *
 * 全局 flag：--protocol --base-url --model --cwd
 */
import { Command } from 'commander';
import { resolveConfig, type CliFlags } from './config.js';
import { cmdChat } from './commands/chat.js';
import { cmdRun } from './commands/run.js';
import { cmdDoctor } from './commands/doctor.js';

const program = new Command();

program
  .name('water')
  .description('Water — AI Agent Harness（学习研究版）')
  .version('0.1.0')
  .option('--protocol <p>', '厂商协议 anthropic | openai')
  .option('--base-url <url>', 'API 端点')
  .option('--model <m>', '模型名')
  .option('--cwd <dir>', '工作区目录');

function cfg(): ReturnType<typeof resolveConfig> {
  const o = program.opts();
  const flags: CliFlags = {};
  if (o.protocol) flags.protocol = o.protocol;
  if (o.baseUrl) flags.baseUrl = o.baseUrl;
  if (o.model) flags.model = o.model;
  if (o.cwd) flags.cwd = o.cwd;
  return resolveConfig(flags);
}

program.command('chat')
  .description('交互式会话')
  .option('--quiet', '静默子代理时间线（TTY 下强制关闭过程输出，只要结论）')
  .action((o: { quiet?: boolean }) => cmdChat(cfg(), o));

program.command('run')
  .description('执行一次性任务')
  .argument('<task>', '任务描述')
  .option('--json', '以 NDJSON 输出 LoopEvent 流')
  .option('--yes', '自动批准所有工具调用（危险）')
  .option('--quiet', '静默子代理时间线（TTY 下强制关闭过程输出，只要结论）')
  .option('--max-turns <n>', '最大轮次', v => Number(v))
  .action((task: string, o: { json?: boolean; yes?: boolean; quiet?: boolean; maxTurns?: number }) =>
    cmdRun(task, cfg(), o));

program.command('doctor')
  .description('环境自检：配置 / 凭据 / 连通性')
  .action(() => cmdDoctor(cfg()));

program.parseAsync().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
