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
  ChatRequest, LoopEvent, Part, Provider, StreamEvent, ToolUsePart, WMessage,
} from './types.js';
import { compactMessages, estimateMessagesTokens, estimateTokens, renderForSummary, splitForSummary } from './context.js';
import { PermissionEngine } from './permissions.js';
import type { Tool, ToolContext } from './tools/index.js';
import type { PluginHooks } from './plugin/types.js';export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  system: string;
  messages: WMessage[];           // 会就地追加（调用方持有完整历史）
  tools: Tool[];
  permissions: PermissionEngine;
  toolCtx: ToolContext;
  maxTurns?: number;              // 防失控上限，默认 20
  maxTokens?: number;
  /** 上下文 token 预算（超窗触发确定性压缩；缺省不限） */
  maxContextTokens?: number;
  /** M9：超预算时优先 LLM 摘要压缩（默认开；失败自动回退确定性裁剪） */
  compactSummarize?: boolean;
  /** 需要用户审批时的回调（CLI/Web 各自实现交互） */
  approve?: (call: ToolUsePart, reason: string) => Promise<'once' | 'session' | 'deny'>;
  /** 插件钩子（P5）：beforeToolCall 返回 false 可阻止执行 */
  hooks?: PluginHooks[];
  signal?: AbortSignal;
}

const SUB_AGENT_SYSTEM = [
  '你是 Water 的只读研究子代理。收到一个自包含的研究问题，用工具（read/grep/glob）收集信息，',
  '然后给出简洁、信息密集的结论。你不能修改文件，不能执行命令，也不能询问用户——独立完成。',
].join('\n');

/**
 * M8：运行一次只读研究子代理（嵌套 Agent Loop）。
 * 防递归双重保险：工具集过滤掉 task + 嵌套 ctx 不注入 spawnTask（用原始 opts.toolCtx）。
 * 中断传播：共享父级 AbortSignal。返回最后一条 assistant 文本。
 */
function runSubAgent(opts: AgentLoopOptions, prompt: string): Promise<string> {
  return (async () => {
    const subMessages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: prompt }] }];
    const subTools = opts.tools.filter(t => t.risk === 'low' && t.spec.name !== 'task');
    try {
      for await (const _ev of agentLoop({
        provider: opts.provider, model: opts.model,
        system: SUB_AGENT_SYSTEM, messages: subMessages, tools: subTools,
        permissions: new PermissionEngine({ autoAllowLowRisk: true }),
        toolCtx: opts.toolCtx, // 原始 ctx（无 spawnTask）
        maxTurns: 10, ...(opts.signal ? { signal: opts.signal } : {}),
      })) { /* 子代理事件不透传（M8 界定；流式子代理块留作后续） */ }
    } catch { /* 中断/异常：返回已收集内容 */ }
    const last = [...subMessages].reverse().find(m => m.role === 'assistant');
    const text = last?.parts
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .map(p => p.text).join('\n').trim();
    return text || '（子代理未产出文本结论）';
  })();
}

const SUMMARY_SYSTEM = [
  '你是对话压缩器。把给定的对话压缩为要点：保留任务目标、已做的关键决定、',
  '未完成事项、重要文件路径与结论。直接输出要点（≤300字），不要任何前言。',
].join('\n');

/** M9：调用当前 provider 生成历史摘要（一次性，maxTokens 受控） */
async function summarizeHistory(provider: Provider, model: string, messages: WMessage[]): Promise<string> {
  const req: ChatRequest = {
    model,
    messages: [
      { role: 'system', parts: [{ type: 'text', text: SUMMARY_SYSTEM }] },
      { role: 'user', parts: [{ type: 'text', text: renderForSummary(messages) }] },
    ],
    maxTokens: 512,
  };
  let out = '';
  for await (const ev of provider.chat(req)) {
    if (ev.type === 'text_delta') out += ev.text;
    else if (ev.type === 'error') throw ev.error;
  }
  if (!out.trim()) throw new Error('摘要为空');
  return out.trim();
}

export async function* agentLoop(opts: AgentLoopOptions): AsyncGenerator<LoopEvent> {
  const maxTurns = opts.maxTurns ?? 20;
  const { provider, permissions } = opts;
  const specs = opts.tools.map(t => t.spec);

  // system 只进第一条消息，后续轮次复用同一份 messages
  if (!opts.messages.some(m => m.role === 'system')) {
    opts.messages.unshift({ role: 'system', parts: [{ type: 'text', text: opts.system }] });
  }

  // M8：工具执行上下文注入子代理派生器（嵌套循环用上面的原始 opts.toolCtx → 天然防递归）
  const execCtx: ToolContext = { ...opts.toolCtx, spawnTask: (prompt: string) => runSubAgent(opts, prompt) };

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) { yield { type: 'finish', reason: 'aborted' }; return; }

    // ---- 上下文预算检查（M2/M9）：超窗时先尝试 LLM 摘要，失败回退确定性压缩 ----
    if (opts.maxContextTokens !== undefined) {
      const estBefore = estimateMessagesTokens(opts.messages);
      if (estBefore > opts.maxContextTokens && opts.compactSummarize !== false) {
        const split = splitForSummary(opts.messages);
        if (split) {
          try {
            const summary = await summarizeHistory(opts.provider, opts.model, split.old);
            opts.messages.length = 0;
            opts.messages.push(
              ...split.head,
              { role: 'user', parts: [{ type: 'text', text: `[此前对话的摘要（上下文管理自动生成）]\n${summary}` }] },
              ...split.kept,
            );
            yield {
              type: 'compacted', method: 'summary',
              droppedMessages: split.old.length, truncatedResults: 0,
              estBefore, estAfter: estimateMessagesTokens(opts.messages),
              summaryTokens: estimateTokens(summary),
            };
          } catch { /* 摘要失败 → 落入下方确定性路径，会话绝不因压缩中断 */ }
        }
      }
      const comp = compactMessages(opts.messages, opts.maxContextTokens);
      if (comp.compacted) {
        yield {
          type: 'compacted', method: 'truncate',
          droppedMessages: comp.droppedMessages, truncatedResults: comp.truncatedResults,
          estBefore: comp.estBefore, estAfter: comp.estAfter,
        };
      }
    }

    yield { type: 'turn_start', turn, model: opts.model };

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
      ...(opts.signal ? { signal: opts.signal } : {}),
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

    // 中断：丢弃半截 assistant 消息（不完整的输出没有回传价值，入历史反而污染下一轮）
    if (opts.signal?.aborted) { yield { type: 'finish', reason: 'aborted' }; return; }

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
        const result = await tool.run(call.input, execCtx);
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
  }

  yield { type: 'finish', reason: 'max_turns', message: `达到最大轮次 ${maxTurns}` };
}
