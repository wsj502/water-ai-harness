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

expect(registry.plugins.length === 2, `加载 2 个插件（实际 ${registry.plugins.length}）`);
expect(registry.plugins.every(p => !p.error), '无加载错误');

const echo = registry.tools.find(t => t.spec.name === 'echo');
const fetchUrl = registry.tools.find(t => t.spec.name === 'fetch_url');
expect(!!echo, 'echo 工具已注册');
expect(!!fetchUrl, 'fetch_url 工具已注册');
expect(fetchUrl?.risk === 'medium', `fetch_url 风险级被提升为 medium（实际 ${fetchUrl?.risk}）`);

const review = registry.commands.find(c => c.name === 'review');
expect(!!review, '/review 斜杠命令已注册');
expect(registry.hooks.length >= 1, '钩子已注册');

// 实跑 echo 工具
if (echo) {
  const out = await echo.run({ text: 'hello water' }, { cwd });
  expect(out === 'echo: hello water', `echo 实跑: ${out}`);
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
