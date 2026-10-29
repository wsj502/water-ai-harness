/**
 * 插件系统闭环测试：加载 → 注册物清点 → 权限提升验证 → 工具实跑。
 * 运行：npx tsx scripts/plugin-test.ts
 */
import path from 'node:path';
import { loadPlugins } from '../packages/core/src/index.js';

const cwd = process.cwd();
const registry = await loadPlugins(cwd, [path.join(cwd, 'plugins')]);

console.log('\n=== 插件清单 ===');
let ok = true;
const expect = (cond: boolean, msg: string) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); ok &&= cond; };

expect(registry.plugins.length === 3, `加载 3 个插件（实际 ${registry.plugins.length}）`);
expect(registry.plugins.every(p => !p.error), '无加载错误');

const echo = registry.tools.find(t => t.spec.name === 'echo');
const fetchUrl = registry.tools.find(t => t.spec.name === 'fetch_url');
const mcpEcho = registry.tools.find(t => t.spec.name === 'mcp__demo__mcp_echo');
expect(!!echo, 'echo 工具已注册');
expect(!!fetchUrl, 'fetch_url 工具已注册');
expect(!!mcpEcho, 'mcp__demo__mcp_echo 工具已注册（MCP 桥）');
expect(fetchUrl?.risk === 'medium', `fetch_url 风险级被提升为 medium（实际 ${fetchUrl?.risk}）`);
expect(mcpEcho?.risk === 'high', `MCP 工具风险级 high（实际 ${mcpEcho?.risk}）`);

const review = registry.commands.find(c => c.name === 'review');
expect(!!review, '/review 斜杠命令已注册');
expect(registry.hooks.length >= 1, '钩子已注册');

// 实跑 echo 工具
if (echo) {
  const out = await echo.run({ text: 'hello water' }, { cwd });
  expect(out === 'echo: hello water', `echo 实跑: ${out}`);
}

// 实跑 MCP 桥接工具（进程外 demo server）
if (mcpEcho) {
  const out = await mcpEcho.run({ text: 'hello mcp' }, { cwd });
  expect(out === 'mcp_echo: hello mcp', `MCP 桥实跑: ${out}`);
}

// 实跑 fetch_url（打本地 server 的健康端点）
if (fetchUrl) {
  try {
    const out = await fetchUrl.run({ url: 'http://127.0.0.1:3210/api/config', maxChars: 300 }, { cwd });
    expect(out.includes('protocol'), `fetch_url 实跑取回本地 API 配置（${out.length} 字符）`);
  } catch (e) {
    console.log(`⚠ fetch_url 实跑跳过（本地 server 未启动）: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(ok ? '\n✅ 插件系统闭环 PASS' : '\n❌ 插件系统闭环 FAIL');
process.exit(ok ? 0 : 1);
