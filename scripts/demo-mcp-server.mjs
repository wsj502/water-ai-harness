/**
 * 最小 MCP stdio server：演示用，暴露一个工具 mcp_echo。
 * 协议：换行分隔的 JSON-RPC 2.0（MCP stdio 传输）。
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', line => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req.method) return;

  // 通知无 id，不回包
  if (req.id === undefined) return;

  switch (req.method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0', id: req.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'water-demo-mcp', version: '0.1.0' },
        },
      });
    case 'tools/list':
      return send({
        jsonrpc: '2.0', id: req.id,
        result: {
          tools: [{
            name: 'mcp_echo',
            description: 'MCP 回声：验证进程外插件链路',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          }],
        },
      });
    case 'tools/call':
      return send({
        jsonrpc: '2.0', id: req.id,
        result: {
          content: [{ type: 'text', text: `mcp_echo: ${req.params?.arguments?.text ?? ''}` }],
        },
      });
    default:
      return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
});
