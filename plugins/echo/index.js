/**
 * echo 插件：最小完整示例，演示插件的全部三种注册能力。
 */

/** @type {import('@water/core').PluginModule} */
export default {
  activate(ctx) {
    // 1. 注册工具
    ctx.registerTool({
      risk: 'low',
      spec: {
        name: 'echo',
        description: '回声测试：原样返回输入文本（用于验证插件链路）',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      argSummary: i => String(i.text ?? '').slice(0, 30),
      async run(input) {
        return `echo: ${String(input.text ?? '')}`;
      },
    });

    // 2. 注册斜杠命令：/review <路径>
    ctx.registerCommand({
      name: 'review',
      description: '请 Agent 审查指定文件',
      template: '请阅读并审查以下文件，指出问题和改进建议：$ARGUMENTS',
    });

    // 3. 注册钩子：记录工具调用审计日志
    ctx.registerHooks({
      afterToolCall(name, ok, durationMs) {
        ctx.logger.info(`tool=${name} ok=${ok} ${durationMs}ms`);
      },
    });

    ctx.logger.info('echo 插件已激活');
  },
};
