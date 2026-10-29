/**
 * 离线闭环测试：MockProvider 模拟「模型请求工具 → 收到结果 → 给出结论」的完整链路。
 * 不需要 API key，用于验证 Agent Loop + 工具 + 权限的协作是否正确。
 *
 * 运行：npx tsx scripts/loop-mock-test.ts
 */
import {
  agentLoop, builtinTools, PermissionEngine,
  type ChatRequest, type Provider, type StreamEvent, type WMessage,
} from '../packages/core/src/index.js';

/** 第一轮要求调 glob，第二轮根据工具结果输出结论 */
class MockProvider implements Provider {
  readonly protocol = 'openai' as const;
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const hasToolResult = req.messages.some(m => m.role === 'tool');
    if (!hasToolResult) {
      yield { type: 'thinking_delta', text: '先看看原型目录有哪些文件…' };
      yield { type: 'text_delta', text: '我来列一下原型文件。' };
      yield {
        type: 'tool_use',
        call: { type: 'tool_use', id: 'mock-1', name: 'glob', input: { pattern: 'prototype/*.html' } },
      };
      yield { type: 'usage', inputTokens: 120, outputTokens: 30 };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      const toolMsg = req.messages.findLast(m => m.role === 'tool');
      const result = toolMsg?.parts[0]?.type === 'tool_result' ? toolMsg.parts[0].content : '';
      yield { type: 'text_delta', text: `找到了这些文件：\n${result}\n结论：原型共 5 页。` };
      yield { type: 'usage', inputTokens: 260, outputTokens: 45 };
      yield { type: 'done', stopReason: 'end' };
    }
  }
}

const messages: WMessage[] = [
  { role: 'user', parts: [{ type: 'text', text: '看看原型目录里有哪些页面？' }] },
];
const permissions = new PermissionEngine({ autoAllowLowRisk: true });

console.log('=== Water Agent Loop 离线闭环测试 ===\n');

for await (const ev of agentLoop({
  provider: new MockProvider(),
  model: 'mock-model',
  system: '你是测试助手。',
  messages,
  tools: builtinTools,
  permissions,
  toolCtx: { cwd: process.cwd() },
  // 不提供 approve：低风险工具自动放行；遇到 ask 会被保守拒绝
})) {
  switch (ev.type) {
    case 'turn_start': console.log(`\n--- 第 ${ev.turn} 轮 ---`); break;
    case 'thinking_delta': process.stdout.write(`💭${ev.text}`); break;
    case 'text_delta': process.stdout.write(ev.text); break;
    case 'tool_pending': console.log(`\n⚙ pending: ${ev.call.name} ${JSON.stringify(ev.call.input)}`); break;
    case 'tool_result':
      console.log(`✓ result (${ev.durationMs}ms): ${ev.result.slice(0, 100).replace(/\n/g, ' | ')}`);
      break;
    case 'usage': console.log(`[tokens in=${ev.inputTokens} out=${ev.outputTokens}]`); break;
    case 'finish': console.log(`\n=== finish: ${ev.reason} ===`); break;
  }
}

// 验证历史结构：system, user, assistant(text+tool_use), tool(result), assistant(final)
const roles = messages.map(m => `${m.role}(${m.parts.map(p => p.type).join(',')})`);
console.log('\n消息历史结构：');
roles.forEach((r, i) => console.log(`  [${i}] ${r}`));

const expected = ['system', 'user', 'assistant', 'tool', 'assistant'];
const ok = expected.every((r, i) => messages[i]?.role === r)
  && messages[2]?.parts.some(p => p.type === 'tool_use')
  && messages[3]?.parts.some(p => p.type === 'tool_result');
console.log(ok ? '\n✅ 闭环测试 PASS' : '\n❌ 闭环测试 FAIL');
process.exit(ok ? 0 : 1);
