/**
 * LoopEvent 终端渲染器：chat 和 run 共用的唯一渲染层。
 * 颜色用 ANSI 转义，零依赖。
 */
import type { LoopEvent } from '@water/core';

const C = {
  reset: '\x1b[0m', dim: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

export class TermRenderer {
  private inThink = false;

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
      case 'finish':
        this.flushThink();
        console.log(`\n${C.dim}--- 结束: ${ev.reason}${ev.message ? ' · ' + ev.message : ''} ---${C.reset}\n`);
        break;
    }
  }

  private flushThink(): void {
    if (this.inThink) { process.stdout.write(`${C.reset}\n`); this.inThink = false; }
  }
}

/** --json 模式：LoopEvent 逐行 NDJSON 输出，供管道消费 */
export function emitNdjson(ev: LoopEvent): void {
  process.stdout.write(JSON.stringify(ev) + '\n');
}
