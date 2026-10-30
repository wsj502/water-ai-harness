/**
 * MCP 桥接插件：读取 mcp.json，拉起进程外 MCP server，
 * 把它们暴露的工具注册为 Water 工具（risk=high，走完整审批流）。
 *
 * 配置位置（后者覆盖前者，数组按 name 合并去重）：
 *   ~/.water/mcp.json  和  <工作区>/.water/mcp.json
 * 格式：
 *   { "servers": [{ "name": "demo", "command": "node", "args": ["scripts/demo-mcp-server.mjs"] }] }
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import readline from 'node:readline';

class McpClient {
  constructor(name, command, args, cwd, env) {
    this.name = name;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.child = spawn(command, args, {
      cwd, stdio: ['pipe', 'pipe', 'inherit'],
      // M13：server 级 env 注入（如 API key 类环境变量，随子进程隔离）
      env: { ...process.env, ...(env ?? {}) },
      // Windows 上只有 .cmd/.bat（如 npm.cmd）才需要壳；裸 exe 走壳反而触发 DEP0190
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    });
    this.child.on('exit', code => {
      for (const [, p] of this.pending) p.reject(new Error(`MCP server ${name} 退出 code=${code}`));
      this.pending.clear();
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === undefined) return; // 通知暂不处理
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
      else p.resolve(msg.result);
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP 请求超时: ${method}`));
      }, 20_000);
    });
  }

  async init() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'water', version: '0.1.0' },
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const { tools } = await this.request('tools/list', {});
    return tools ?? [];
  }

  dispose() { this.child.kill(); }
}

function loadMcpConfig(cwd) {
  const files = [
    path.join(homedir(), '.water', 'mcp.json'),
    path.join(cwd, '.water', 'mcp.json'),
  ];
  const servers = new Map();
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      // M13：业界通行形状 {mcpServers: {name: {command, args, env}}}（Claude/OpenCode 同构）
      if (j.mcpServers && typeof j.mcpServers === 'object') {
        for (const [name, s] of Object.entries(j.mcpServers)) {
          if (s?.command) servers.set(name, { name, ...s });
        }
      }
      // 旧版形状 {servers: [{name, command, args}]}：兼容读取并告警
      if (Array.isArray(j.servers)) {
        for (const s of j.servers) {
          if (s?.name && s?.command && !servers.has(s.name)) {
            console.warn(`[mcp-bridge] 旧版 servers[] 格式建议迁移到 mcpServers{}：${s.name}`);
            servers.set(s.name, s);
          }
        }
      }
    } catch (e) {
      console.error(`[mcp-bridge] 解析 ${f} 失败: ${e.message}`);
    }
  }
  return [...servers.values()];
}

/** @type {import('@water/core').PluginModule} */
export default {
  async activate(ctx) {
    this._clients = [];
    const servers = loadMcpConfig(ctx.cwd);
    if (servers.length === 0) {
      ctx.logger.info('未发现 mcp.json，桥接空闲');
      return;
    }

    for (const s of servers) {
      try {
        const client = new McpClient(s.name, s.command, s.args ?? [], ctx.cwd, s.env);
        const tools = await client.init();
        this._clients.push(client);

        for (const t of tools) {
          const fullName = `mcp__${s.name}__${t.name}`;
          ctx.registerTool({
            risk: 'high', // 进程外能力，默认最严
            spec: {
              name: fullName,
              description: `[MCP:${s.name}] ${t.description ?? t.name}`,
              inputSchema: t.inputSchema ?? { type: 'object' },
            },
            argSummary: () => `${s.name}.${t.name}`,
            async run(input) {
              const result = await client.request('tools/call', { name: t.name, arguments: input });
              const contents = result?.content ?? [];
              return contents.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n')
                || JSON.stringify(result);
            },
          });
        }
        ctx.logger.info(`MCP server "${s.name}" 接入，工具 ${tools.length} 个`);
      } catch (e) {
        ctx.logger.error(`MCP server "${s.name}" 启动失败: ${e.message}`);
      }
    }
  },

  async deactivate() {
    for (const c of this._clients ?? []) c.dispose();
  },
};
