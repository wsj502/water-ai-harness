/**
 * Agent Loop：模型与工具的往返调度。
 *
 * 一轮（turn）= 模型流式输出 → 收集 text/thinking/tool_use →
 * 若有 tool_use：逐个审批+执行 → 结果回填为 tool 消息 → 进入下一轮；
 * 若没有 tool_use（stopReason=end）：结束。
 *
 * 产出是 LoopEvent 流，UI（CLI/Web/桌面）只消费这条流，不关心厂商协议。
 */
import type {
  LoopEvent, Part, Provider, ToolUsePart, WMessage,
} from './types.js';
import { PermissionEngine } from './permissions.js';
import type { Tool, ToolContext } from './tools/index.js';
import type { PluginHooks } from './plugin/types.js';

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  system: string;
  messages: WMessage[];           // 会就地追加（调用方持有完整历史）
  tools: Tool[];
  permissions: PermissionEngine;
  toolCtx: ToolContext;
  maxTurns?: number;              // 防失控上限，默认 20
  maxTokens?: number;
  /** 需要用户审批时的回调（CLI/Web 各自实现交互） */
  approve?: (call: ToolUsePart, reason: string) => Promise<'once' | 'session' | 'deny'>;
  /** 插件钩子（P5）：beforeToolCall 返回 false 可阻止执行 */
  hooks?: PluginHooks[];
  signal?: AbortSignal;
}

export async function* agentLoop(opts: AgentLoopOptions): AsyncGenerator<LoopEvent> {
  const maxTurns = opts.maxTurns ?? 20;
  const { provider, permissions } = opts;
  const specs = opts.tools.map(t => t.spec);

  // system 只进第一条消息，后续轮次复用同一份 messages
  if (!opts.messages.some(m => m.role === 'system')) {
    opts.messages.unshift({ role: 'system', parts: [{ type: 'text', text: opts.system }] });
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) { yield { type: 'finish', reason: 'aborted' }; return; }
    yield { type: 'turn_start', turn };

    // ---- 一轮模型调用：流式收集 ----
    const parts: Part[] = [];
    let textBuf = '', thinkBuf = '';
    const toolCalls: ToolUsePart[] = [];
    let stopReason = 'unknown';
    let streamError: Error | null = null;

    for await (const ev of provider.chat({
      model: opts.model,
      messages: opts.messages,
      tools: specs,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    })) {
      switch (ev.type) {
        case 'text_delta':
          textBuf += ev.text;
          yield { type: 'text_delta', text: ev.text };
          break;
        case 'thinking_delta':
          thinkBuf += ev.text;
          yield { type: 'thinking_delta', text: ev.text };
          break;
        case 'tool_use':
          toolCalls.push(ev.call);
          break;
        case 'usage':
          yield { type: 'usage', inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
          break;
        case 'done':
          stopReason = ev.stopReason;
          break;
        case 'error':
          streamError = ev.error;
          break;
      }
      if (streamError) break;
    }

    if (streamError) {
      yield { type: 'finish', reason: 'error', message: streamError.message };
      return;
    }

    // 本轮 assistant 消息落历史
    if (thinkBuf) parts.push({ type: 'thinking', text: thinkBuf });
    if (textBuf) parts.push({ type: 'text', text: textBuf });
    parts.push(...toolCalls);
    opts.messages.push({ role: 'assistant', parts });

    // ---- 无工具调用：结束 ----
    if (toolCalls.length === 0 || stopReason === 'end') {
      yield { type: 'finish', reason: 'end' };
      return;
    }

    // ---- 执行工具：审批 → 执行 → 结果回填 ----
    const resultParts: Part[] = [];
    let anyDenied = false;

    for (const call of toolCalls) {
      yield { type: 'tool_pending', call };

      const tool = opts.tools.find(t => t.spec.name === call.name);
      if (!tool) {
        resultParts.push({
          type: 'tool_result', toolUseId: call.id,
          content: `错误：未知工具 ${call.name}`, isError: true,
        });
        continue;
      }

      // 权限检查
      const summary = tool.argSummary(call.input);
      let decision = permissions.check(call.name, tool.risk, summary);
      if (decision === 'ask') {
        if (!opts.approve) {
          decision = 'deny'; // 无交互渠道时保守拒绝
        } else {
          const r = await opts.approve(call, summary);
          if (r === 'deny') decision = 'deny';
          else {
            if (r === 'session') permissions.grantSession(`${call.name}:${summary}`);
            decision = 'allow';
            yield { type: 'tool_approved', call, scope: r };
          }
        }
      }

      if (decision === 'deny') {
        anyDenied = true;
        yield { type: 'tool_denied', call };
        resultParts.push({
          type: 'tool_result', toolUseId: call.id,
          content: '用户拒绝了本次工具调用。请不要重试相同操作，改为说明你可以如何继续。',
          isError: true,
        });
        continue;
      }

      // 插件钩子：beforeToolCall 返回 false → 阻止执行
      let blockedBy: string | null = null;
      for (const h of opts.hooks ?? []) {
        try {
          if (h.beforeToolCall?.(call.name, call.input) === false) {
            blockedBy = call.name;
            break;
          }
        } catch { /* 钩子异常不阻断主流程 */ }
      }
      if (blockedBy) {
        yield { type: 'tool_denied', call };
        resultParts.push({
          type: 'tool_result', toolUseId: call.id,
          content: `插件钩子阻止了 ${call.name} 的执行。`, isError: true,
        });
        continue;
      }

      const started = Date.now();
      try {
        const result = await tool.run(call.input, opts.toolCtx);
        const durationMs = Date.now() - started;
        for (const h of opts.hooks ?? []) { try { h.afterToolCall?.(call.name, true, durationMs); } catch { /* 忽略 */ } }
        yield { type: 'tool_result', call, result, isError: false, durationMs };
        resultParts.push({ type: 'tool_result', toolUseId: call.id, content: result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const durationMs = Date.now() - started;
        for (const h of opts.hooks ?? []) { try { h.afterToolCall?.(call.name, false, durationMs); } catch { /* 忽略 */ } }
        yield { type: 'tool_result', call, result: msg, isError: true, durationMs };
        resultParts.push({ type: 'tool_result', toolUseId: call.id, content: `工具执行错误：${msg}`, isError: true });
      }
    }

    // 结果回填为 tool 消息，进入下一轮
    opts.messages.push({ role: 'tool', parts: resultParts });
    if (anyDenied && toolCalls.length === resultParts.filter(p => (p as { isError?: boolean }).isError).length) {
      // 全部工具都被拒/出错时多给模型一轮解释机会，随后由 stopReason=end 收尾
    }
  }

  yield { type: 'finish', reason: 'max_turns', message: `达到最大轮次 ${maxTurns}` };
}
