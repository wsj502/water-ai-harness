/**
 * Water 消息模型 —— 内核内部唯一认可的数据格式。
 *
 * 设计原则（见 docs/articles/02）：
 * 1. 内核不认识任何厂商协议，只认这里的类型；
 * 2. 厂商差异全部收敛在 providers/ 适配器里双向翻译；
 * 3. 一条消息 = role + parts[]，part 是可组合的块（文本/思考/工具调用/工具结果），
 *    这样 Anthropic 的 content block 和 OpenAI 的 tool_calls 都能无损映射进来。
 */

// ---------- 消息部件 ----------

export interface TextPart {
  type: 'text';
  text: string;
}

/** 推理模型的思考过程（R1/o1 类），UI 默认折叠渲染 */
export interface ThinkingPart {
  type: 'thinking';
  text: string;
}

/** 模型请求调用工具（assistant 消息里） */
export interface ToolUsePart {
  type: 'tool_use';
  /** 本次调用的唯一 id，tool_result 靠它回填 */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 工具执行结果（role: 'tool' 消息里） */
export interface ToolResultPart {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type Part = TextPart | ThinkingPart | ToolUsePart | ToolResultPart;

// ---------- 消息 ----------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface WMessage {
  role: Role;
  parts: Part[];
}

// ---------- 工具描述（发给模型的 schema） ----------

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema（object 类型），描述 input 参数 */
  inputSchema: Record<string, unknown>;
}

// ---------- 流式事件（Provider → 内核） ----------

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; call: ToolUsePart }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; stopReason: 'end' | 'tool_use' | 'max_tokens' | 'unknown' }
  | { type: 'error'; error: Error };

// ---------- Provider 抽象 ----------

export interface ChatRequest {
  model: string;
  messages: WMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  /** 0~1，缺省由 provider 决定 */
  temperature?: number;
}

export interface ProviderConfig {
  /** 线协议：决定用哪个适配器 */
  protocol: 'anthropic' | 'openai';
  baseUrl: string;
  apiKey: string;
}

/**
 * Provider 适配器契约：把 WMessage[] 翻译成厂商请求，
 * 把厂商 SSE 流翻译回 StreamEvent。
 */
export interface Provider {
  readonly protocol: ProviderConfig['protocol'];
  chat(req: ChatRequest): AsyncIterable<StreamEvent>;
}

// ---------- Agent Loop 事件（内核 → UI） ----------

export type LoopEvent =
  | { type: 'turn_start'; turn: number; model?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_pending'; call: ToolUsePart }
  | { type: 'tool_approved'; call: ToolUsePart; scope: 'once' | 'session' }
  | { type: 'tool_denied'; call: ToolUsePart }
  | { type: 'tool_result'; call: ToolUsePart; result: string; isError: boolean; durationMs: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'finish'; reason: 'end' | 'max_turns' | 'aborted' | 'error'; message?: string };
