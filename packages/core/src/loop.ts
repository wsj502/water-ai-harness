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

const SUB_AGENT_READ_SYSTEM = [
  '你是 Water 的只读研究子代理。收到一个自包含的研究问题，用工具（read/grep/glob）收集信息，',
  '然后给出简洁、信息密集的结论。你不能修改文件，不能执行命令，也不能询问用户——独立完成。',
].join('\n');

const SUB_AGENT_WRITE_SYSTEM = [
  '你是 Water 的可写执行子代理。收到一个自包含的任务：先用 read/grep/glob 弄清现状，',
  '再用 write/edit 完成修改。小步快跑，改动前先读目标文件；不要执行命令；不要询问用户。',
  '完成后用一两句话说明改了什么、为什么这样改。',
].join('\n');

/** write 模式的工具白名单（无 shell、无递归 task） */
const SUB_WRITE_TOOLS = new Set(['read', 'grep', 'glob', 'write', 'edit']);

/**
 * M8/M12/M15：运行一次子代理（嵌套 Agent Loop）。
 * mode=read 只读调研；mode=write 可写执行——M15 起子级 write/edit 不再预授权
 * （撤销 M12 的会话级放行），每次写入路由到父级审批桥：callId 加 `${parentCallId}:`
 * 前缀命名空间（与主循环审批不碰撞），审批桥/pending/断开全拒语义与主循环完全复用。
 * 防递归双重保险：工具集过滤掉 task + 嵌套 ctx 不注入 spawnTask（用原始 opts.toolCtx）。
 * onEvent：子代理事件实时透传（M12 流式）。中断传播：共享父级 AbortSignal。
 */
function runSubAgent(
  opts: AgentLoopOptions,
  prompt: string,
  mode: 'read' | 'write',
  onEvent?: (ev: LoopEvent) => void,
  parentCallId?: string,
): Promise<string> {
  return (async () => {
    const subMessages: WMessage[] = [{ role: 'user', parts: [{ type: 'text', text: prompt }] }];
    const subTools = opts.tools.filter(t =>
      t.spec.name !== 'task' && (mode === 'write' ? SUB_WRITE_TOOLS.has(t.spec.name) : t.risk === 'low'));
    // M21 授权继承：子级引擎预置父会话的文件粒度授权（write:/edit: 前缀；裸授权不继承——
    // 主循环的会话级放行不外溢为子代理写权限）——跨子代理同文件免重复审批。
    const inherited = opts.permissions.inheritableGrants(['write:', 'edit:']);
    const subPermissions = new PermissionEngine({ autoAllowLowRisk: true, initialGrants: inherited });
    // M15 审批透传：子级 write/edit（medium → ask）逐次路由到父级 approve 回调；
    // 无审批渠道（opts.approve 缺失）→ 引擎 ask → 保守拒绝、零落盘（与主循环同语义）。
    // M21：子级「session」决策按文件粒度上浮父会话引擎（`${工具}:${路径}`）——后续子代理经继承生效；
    // 「once」不上浮；task(write) 的 session 授权不隐含子级写授权（派生≠写入，M15 粒度不回退）。
    // shell 不在子工具集内，即便模型请求也会被默认策略拒绝。
    const subApprove: AgentLoopOptions['approve'] | undefined =
      opts.approve && parentCallId
        ? (call, reason) => opts.approve!({ ...call, id: `${parentCallId}:${call.id}` }, `[子代理] ${reason}`)
          .then(r => {
            if (r === 'session') {
              const summary = opts.tools.find(t => t.spec.name === call.name)?.argSummary(call.input) ?? '';
              opts.permissions.grantSession(`${call.name}:${summary}`); // 上浮：文件粒度 key
            }
            return r;
          })
        : undefined;
    try {
      for await (const ev of agentLoop({
        provider: opts.provider, model: opts.model,
        system: mode === 'write' ? SUB_AGENT_WRITE_SYSTEM : SUB_AGENT_READ_SYSTEM,
        messages: subMessages, tools: subTools,
        permissions: subPermissions,
        toolCtx: opts.toolCtx, // 原始 ctx（无 spawnTask）
        maxTurns: 10, ...(opts.signal ? { signal: opts.signal } : {}),
        ...(subApprove ? { approve: subApprove } : {}),
      })) {
        onEvent?.(ev); // M12：实时透传（含 compacted 等管理事件——完整还原子过程）
      }
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

  // M8/M12：工具执行上下文注入子代理派生器（嵌套循环用上面的原始 opts.toolCtx → 天然防递归）
  const execCtx: ToolContext = {
    ...opts.toolCtx,
    spawnTask: (prompt: string, spawnOpts?: { mode?: 'read' | 'write'; onEvent?: (ev: LoopEvent) => void; parentCallId?: string }) =>
      runSubAgent(opts, prompt, spawnOpts?.mode === 'write' ? 'write' : 'read',
        spawnOpts?.onEvent, spawnOpts?.parentCallId),
  };

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

      // 权限检查（M12：动态风险——riskFor 按实参计算，如 task write 模式提升为 high）
      const summary = tool.argSummary(call.input);
      const risk = tool.riskFor?.(call.input) ?? tool.risk;
      let decision = permissions.check(call.name, risk, summary);
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
        // M12 事件泵：工具执行期间把子代理事件实时 yield（sub_event 包装，关联当前 callId）。
        // 实现方式：临时包一层 spawnTask，把 onEvent 注入当前泵——工具串行执行，无并发竞争。
        const subQ: LoopEvent[] = [];
        let wake: (() => void) | null = null;
        let settled = false;
        const originalSpawn = execCtx.spawnTask;
        if (originalSpawn) {
          // M15：除 onEvent 外再注入 parentCallId（当前 task 调用）——子级审批桥按它命名空间
          execCtx.spawnTask = (prompt: string, so?: { mode?: 'read' | 'write'; onEvent?: (ev: LoopEvent) => void; parentCallId?: string }) =>
            originalSpawn(prompt, {
              ...so,
              onEvent: ev => { subQ.push(ev); wake?.(); so?.onEvent?.(ev); },
              parentCallId: call.id,
            });
        }

        let runResult: string;
        try {
          const runP = tool.run(call.input, execCtx)
            .finally(() => { settled = true; wake?.(); });
          while (!settled || subQ.length > 0) {
            while (subQ.length > 0) {
              yield { type: 'sub_event', callId: call.id, ev: subQ.shift()! };
            }
            if (!settled) await new Promise<void>(r => { wake = r; });
          }
          runResult = await runP;
        } finally {
          if (originalSpawn) execCtx.spawnTask = originalSpawn;
        }

        const result = runResult;
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
