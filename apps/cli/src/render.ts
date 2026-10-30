/**
 * LoopEvent 终端渲染器：chat 和 run 共用的唯一渲染层。
 * 颜色用 ANSI 转义，零依赖。
 * M20：sub_event 折叠为缩进时间线（与 Web M18 同语义、终端表达）；
 * quiet 模式（非 TTY / 显式指定）下子代理过程静默——不打爆管道输出。
 */
import type { LoopEvent } from '@water/core';

const C = {
  reset: '\x1b[0m', dim: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

export class TermRenderer {
  private inThink = false;
  private subInText = false;
  /** M20：非交互（管道/重定向）默认静默子代理过程，可显式覆盖 */
  private readonly quiet: boolean;

  constructor(opts: { quiet?: boolean } = {}) {
    this.quiet = opts.quiet ?? !process.stdout.isTTY;
  }

  handle(ev: LoopEvent): void {
    switch (ev.type) {
      case 'turn_start':
        if (ev.turn > 1) process.stdout.write(`\n${C.dim}--- 第 ${ev.turn} 轮 ---${C.reset}\n`);
        break;
      case 'thinking_delta':
        if (!this.inThink) { process.stdout.write(`${C.magenta}💭 `); this.inThink = true; }
        process.stdout.write(ev.text);
        break;
      case 'text_delta':
        if (this.inThink) { process.stdout.write(`${C.reset}\n`); this.inThink = false; }
        process.stdout.write(ev.text);
        break;
      case 'tool_pending':
        this.flushThink();
        console.log(`\n${C.cyan}⚙ ${ev.call.name}${C.reset} ${JSON.stringify(ev.call.input).slice(0, 120)}`);
        break;
      case 'tool_approved':
        console.log(`  ${C.dim}已允许（${ev.scope === 'session' ? '本会话' : '一次'}）${C.reset}`);
        break;
      case 'tool_denied':
        console.log(`  ${C.red}✗ 已拒绝${C.reset}`);
        break;
      case 'tool_result':
        console.log(
          `  ${ev.isError ? C.red : C.dim}${ev.isError ? '✗' : '✓'} ${ev.durationMs}ms ` +
          `${ev.result.slice(0, 160).replace(/\n/g, ' ⏎ ')}${C.reset}`,
        );
        break;
      case 'usage':
        console.log(`${C.dim}[tokens: in=${ev.inputTokens} out=${ev.outputTokens}]${C.reset}`);
        break;
      case 'sub_event':
        if (this.quiet) break; // 管道/重定向：子代理过程静默（主循环 tool_result 已有结论）
        this.renderSub(ev.callId, ev.ev);
        break;
      case 'finish':
        this.flushThink();
        this.flushSubText();
        console.log(`\n${C.dim}--- 结束: ${ev.reason}${ev.message ? ' · ' + ev.message : ''} ---${C.reset}\n`);
        break;
    }
  }

  /** M20：子代理事件 → 缩进时间线（轮次分隔 / 工具行+状态 / 文本流 / 审批结果行） */
  private renderSub(callId: string, inner: LoopEvent): void {
    if (inner.type === 'text_delta') {
      if (!this.subInText) { process.stdout.write(`${C.dim}  `); this.subInText = true; }
      process.stdout.write(inner.text);
      return;
    }
    this.flushSubText();
    switch (inner.type) {
      case 'turn_start':
        console.log(`${C.dim}  ── 子代理[${callId.slice(0, 10)}] 第 ${inner.turn} 轮 ──${C.reset}`);
        break;
      case 'tool_pending':
        console.log(`  ${C.cyan}⚙ ${inner.call.name}${C.reset} ${JSON.stringify(inner.call.input).slice(0, 100)}`);
        break;
      case 'tool_approved':
        console.log(`    ${C.dim}已允许（${inner.scope === 'session' ? '本会话' : '一次'}）${C.reset}`);
        break;
      case 'tool_denied':
        console.log(`    ${C.red}⛔ 已拒绝${C.reset}`);
        break;
      case 'tool_result':
        console.log(
          `    ${inner.isError ? C.red : C.dim}${inner.isError ? '✗' : '✓'} ${inner.durationMs}ms ` +
          `${inner.result.slice(0, 120).replace(/\n/g, ' ⏎ ')}${C.reset}`,
        );
        break;
      default:
        break; // thinking/usage/compacted 不展开（与 Web 时间线一致的取舍）
    }
  }

  private flushThink(): void {
    if (this.inThink) { process.stdout.write(`${C.reset}\n`); this.inThink = false; }
  }

  private flushSubText(): void {
    if (this.subInText) { process.stdout.write(`${C.reset}\n`); this.subInText = false; }
  }
}

/** --json 模式：LoopEvent 逐行 NDJSON 输出，供管道消费 */
export function emitNdjson(ev: LoopEvent): void {
  process.stdout.write(JSON.stringify(ev) + '\n');
}
