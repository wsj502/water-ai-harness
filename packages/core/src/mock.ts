/**
 * MockProvider：离线开发/测试用。不配 key 时 Web/Server 也能完整走通链路。
 * 行为：第一轮固定请求 glob，第二轮根据工具结果给结论。
 * 每轮带 ~150ms「网络节奏」：离线体验贴近真实，且并发/排队行为可被测试
 * （无延迟时执行快于请求到达抖动，排队永不触发）。
 * 启用方式：WATER_MOCK=1
 */
import type { ChatRequest, Provider, StreamEvent } from './types.js';

const RTT = Number(process.env.WATER_MOCK_RTT_MS ?? 150);

export class MockProvider implements Provider {
  readonly protocol = 'openai' as const;

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    await new Promise(r => setTimeout(r, RTT));
    const hasToolResult = req.messages.some(m => m.role === 'tool');
    // M15 场景剧本：按用户消息中的标记驱动（默认行为不变）——离线 E2E 用它确定性复现子级审批
    const lastUser = req.messages.findLast(m => m.role === 'user');
    const userText = lastUser?.parts[0]?.type === 'text' ? (lastUser.parts[0] as { text: string }).text : '';
    if (userText.includes('[[mock:m15-sub]]')) {
      // 子代理对话：首轮请求 write（触发 M15 子级审批），拿到结果后收尾
      if (!hasToolResult) {
        yield {
          type: 'tool_use',
          call: { type: 'tool_use', id: 'mock-sub-w1', name: 'write', input: { path: 'm15-note.txt', content: 'written-by-subagent' } },
        };
        yield { type: 'done', stopReason: 'tool_use' };
      } else {
        yield { type: 'text_delta', text: '（mock 子代理）已处理写入请求。' };
        yield { type: 'usage', inputTokens: 150, outputTokens: 30 };
        yield { type: 'done', stopReason: 'end' };
      }
      return;
    }
    if (userText.includes('[[mock:m15-task]]') && !hasToolResult) {
      yield { type: 'thinking_delta', text: '（mock）派生可写子代理…' };
      yield {
        type: 'tool_use',
        call: { type: 'tool_use', id: 'mock-task-m15', name: 'task', input: { mode: 'write', description: 'M15 审批透传演示', prompt: '[[mock:m15-sub]] 创建 m15-note.txt' } },
      };
      yield { type: 'usage', inputTokens: 100, outputTokens: 20 };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    // M17 场景剧本：[[mock:m17tool:<工具名>]] 让 mock 调用指定的（配置式声明）工具
    const m17 = userText.match(/\[\[mock:m17tool:([A-Za-z0-9_-]+)\]\]/);
    if (m17 && !hasToolResult) {
      const toolName = m17[1]!;
      if (!req.tools?.some(t => t.name === toolName)) {
        yield { type: 'text_delta', text: `（mock）工具清单中没有 ${toolName}` };
        yield { type: 'done', stopReason: 'end' };
        return;
      }
      yield { type: 'tool_use', call: { type: 'tool_use', id: 'mock-m17-call', name: toolName, input: { text: 'hello-m17' } } };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    if (!hasToolResult) {
      yield { type: 'thinking_delta', text: '（mock）先看看工作区结构…' };
      yield { type: 'text_delta', text: '我先列一下工作区文件。' };
      yield {
        type: 'tool_use',
        call: { type: 'tool_use', id: `mock-${Date.now()}`, name: 'glob', input: { pattern: '*.{json,md}' } },
      };
      yield { type: 'usage', inputTokens: 100, outputTokens: 20 };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      const toolMsg = req.messages.findLast(m => m.role === 'tool');
      const result = toolMsg?.parts[0]?.type === 'tool_result' ? toolMsg.parts[0].content : '';
      yield { type: 'text_delta', text: `（mock）工具返回：\n${result.slice(0, 500)}\n\n链路正常，配置真实 key 后即可对接 GLM。` };
      yield { type: 'usage', inputTokens: 200, outputTokens: 40 };
      yield { type: 'done', stopReason: 'end' };
    }
  }
}
