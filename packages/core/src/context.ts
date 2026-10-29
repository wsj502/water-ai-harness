/**
 * 上下文管理器（M2）：token 预算估算 + 超窗确定性压缩。
 *
 * 这是 00-导读架构图里「CTX 上下文管理」模块的落地——0.1.0 时代唯一
 * 「画了没做」的部分。设计取舍：
 *
 * 1. 估算而非精确：不引 tokenizer 依赖（内核零依赖红线），用中英混合
 *    启发式做「预算级」估算——目的只是防超窗，不做计费；
 * 2. 确定性优先：先裁旧 tool_result（模型最不需要的 token），再丢最旧
 *    轮次；LLM 摘要压缩是将来可选增强（需要额外一次模型调用）；
 * 3. 结构合法性：压缩后第一条非 system 消息必须是 user（两家协议的
 *    共同要求），孤儿 tool_result 一并清退。
 */
import type { WMessage } from './types.js';

/** 单段文本的 token 估算：CJK ≈ 1 字/token，其他 ≈ 3.8 字符/token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // CJK 统一表意、日文假名、全角符号区
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x30ff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 3.8);
}

/** 一份历史的 token 估算（含 system；tool_use 按序列化后的 JSON 估算） */
export function estimateMessagesTokens(messages: WMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'thinking') total += estimateTokens(p.text);
      else if (p.type === 'tool_use') total += estimateTokens(JSON.stringify(p.input)) + 16;
      else if (p.type === 'tool_result') total += estimateTokens(p.content) + 8;
    }
    total += 4; // role/结构开销
  }
  return total;
}

export interface CompactResult {
  compacted: boolean;
  /** 丢弃的完整消息数（不含 system） */
  droppedMessages: number;
  /** 被截断的 tool_result 数 */
  truncatedResults: number;
  estBefore: number;
  estAfter: number;
}

/** 压缩单条 tool_result：保留首尾，中间替换为占位（最近一轮的不动） */
function truncateResult(content: string): string {
  const head = content.slice(0, 160);
  const tail = content.slice(-60);
  return `${head}\n…[上下文压缩：省略 ${content.length - 220} 字符]…\n${tail}`;
}

/**
 * 就地压缩历史到预算内（messages 数组被修改——调用方持有完整历史，
 * 压缩即遗忘，这是上下文管理的本质）。
 *
 * 逐级降级：A 裁旧 tool_result → B 丢最旧轮次（保 system + 最近消息，
 * 且保证压缩后首条非 system 消息为 user）。
 */
export function compactMessages(messages: WMessage[], budget: number): CompactResult {
  const estBefore = estimateMessagesTokens(messages);
  if (estBefore <= budget) {
    return { compacted: false, droppedMessages: 0, truncatedResults: 0, estBefore, estAfter: estBefore };
  }

  // ---- A：截断旧 tool_result（保留最近 3 条消息里的不动） ----
  let truncatedResults = 0;
  const recentGuard = Math.max(0, messages.length - 3);
  for (let i = 0; i < recentGuard; i++) {
    for (let j = 0; j < messages[i]!.parts.length; j++) {
      const p = messages[i]!.parts[j]!;
      if (p.type === 'tool_result' && p.content.length > 300) {
        p.content = truncateResult(p.content);
        truncatedResults++;
      }
    }
  }

  // ---- B：从最旧处丢整段，直到入预算或只剩最小保留集 ----
  let droppedMessages = 0;
  while (estimateMessagesTokens(messages) > budget && messages.length > 4) {
    messages.splice(1, 1); // 永不动 messages[0]（system）
    droppedMessages++;
    // 合法性：首条非 system 消息必须是 user；顺带清退孤儿 tool_result
    while (messages.length > 1 && messages[1]!.role !== 'user') {
      messages.splice(1, 1);
      droppedMessages++;
    }
  }

  const estAfter = estimateMessagesTokens(messages);
  return { compacted: true, droppedMessages, truncatedResults, estBefore, estAfter };
}
