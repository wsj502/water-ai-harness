/**
 * M13 配置式命令测试：解析/校验/红线（WATER_CONFIG_FILE 注入测试路径）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configHttpToolToTool, configToolToTool, loadFileConfig } from '../packages/core/src/index.js';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

const realEnv = process.env.WATER_CONFIG_FILE;
afterEach(() => {
  if (realEnv === undefined) delete process.env.WATER_CONFIG_FILE;
  else process.env.WATER_CONFIG_FILE = realEnv;
});

function withConfig(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'water-cfg-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('配置式命令解析（M13）', () => {
  it('合法条目：name/template/description 完整读出', () => {
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({
      commands: [
        { name: 'review', template: '请审查以下代码：$ARGUMENTS', description: '代码审查' },
        { name: 'test-2', template: '跑测试 $ARGUMENTS' },
      ],
    }));
    const cfg = loadFileConfig();
    expect(cfg.commands).toHaveLength(2);
    expect(cfg.commands![0]).toMatchObject({ name: 'review', description: '代码审查' });
    expect(cfg.commands![1]!.template).toContain('$ARGUMENTS');
  });

  it('非法 name（路径/空格/数字开头）被拒', () => {
    for (const bad of ['has space', 'a/b', '1num', '']) {
      process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({ commands: [{ name: bad, template: 'x' }] }));
      expect(() => loadFileConfig()).toThrow(/name/);
    }
  });

  it('不支持的字段被白名单拒绝（防夹带）', () => {
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({
      commands: [{ name: 'ok', template: 'x', command: 'rm -rf /' }],
    }));
    expect(() => loadFileConfig()).toThrow(/不支持的字段/);
  });

  it('顶层凭据字段红线不受影响', () => {
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({ apiKey: 'sk-x', commands: [{ name: 'a', template: 'b' }] }));
    expect(() => loadFileConfig()).toThrow(/凭据字段/);
  });

  it('缺省无 commands：字段不出现（exactOptionalPropertyTypes 契约）', () => {
    process.env.WATER_CONFIG_FILE = withConfig('{}');
    const cfg = loadFileConfig();
    expect('commands' in cfg).toBe(false);
  });
});

describe('配置式声明工具解析（M17）', () => {
  it('合法条目：name/description/template/parameters 完整读出', () => {
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({
      tools: [{
        name: 'seal',
        description: '盖章',
        template: '已盖章：$text',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }],
    }));
    const cfg = loadFileConfig();
    expect(cfg.tools).toHaveLength(1);
    expect(cfg.tools![0]).toMatchObject({ name: 'seal', description: '盖章' });
    expect(cfg.tools![0]!.parameters).toHaveProperty('required');
  });

  it('非法条目被拒：坏 name / 缺 description / 空 template / parameters 非对象 / 缺 template', () => {
    const bad: unknown[] = [
      [{ name: '1bad', description: 'd', template: 't' }],
      [{ name: 'ok' }],
      [{ name: 'ok', description: 'd' }],
      [{ name: 'ok', description: 'd', template: '   ' }],
      [{ name: 'ok', description: 'd', template: 't', parameters: 'not-object' }],
    ];
    for (const tools of bad) {
      process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({ tools }));
      expect(() => loadFileConfig(), JSON.stringify(tools)).toThrow();
    }
  });

  it('不支持的字段被白名单拒绝（防夹带执行体——prompt 型无 command/url 等字段）', () => {
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({
      tools: [{ name: 'evil', description: 'd', template: 't', command: 'rm -rf /' }],
    }));
    expect(() => loadFileConfig()).toThrow(/不支持的字段/);
  });

  it('缺省无 tools：字段不出现（exactOptionalPropertyTypes 契约）', () => {
    process.env.WATER_CONFIG_FILE = withConfig('{"commands":[{"name":"a","template":"b"}]}');
    expect('tools' in loadFileConfig()).toBe(false);
  });
});

describe('配置式工具包装（M17 configToolToTool · prompt 型）', () => {
  it('模板 $参数名 替换为模型入参；无 parameters 给空对象 schema；风险级 low', async () => {
    const t = configToolToTool({
      name: 'seal',
      description: '盖章',
      template: '已盖章：$text（副本 $copy）',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    });
    expect(t.risk).toBe('low');
    expect(t.spec.name).toBe('seal');
    expect(t.spec.inputSchema).toHaveProperty('required');
    expect(await t.run({ text: '机密文件' }, { cwd: '.' })).toBe('已盖章：机密文件（副本 ）');
    const noParam = configToolToTool({ name: 'ping', description: 'ping', template: 'pong' });
    expect(noParam.spec.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(await noParam.run({}, { cwd: '.' })).toBe('pong');
  });
});

describe('配置式声明工具 · http 型解析（M22）', () => {
  it('合法 http 条目 + 白名单通过：kind/http 读出，method 归一为大写', () => {
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({
      allowedHttpHosts: ['api.example.com', '127.0.0.1'],
      tools: [{
        name: 'lookup', kind: 'http', description: '查',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        http: { url: 'https://api.example.com/v1?q=$q', method: 'get', headers: { Authorization: 'Bearer $env:MY_KEY' } },
      }],
    }));
    const cfg = loadFileConfig();
    expect(cfg.allowedHttpHosts).toEqual(['api.example.com', '127.0.0.1']);
    expect(cfg.tools![0]!.kind).toBe('http');
    expect(cfg.tools![0]!.http).toMatchObject({ url: 'https://api.example.com/v1?q=$q', method: 'GET' });
  });

  it('白名单红线（防 SSRF）：host 不在白名单 / 未配置白名单 → 启动即拒', () => {
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({
      allowedHttpHosts: ['good.example.com'],
      tools: [{ name: 'bad', kind: 'http', description: 'd', http: { url: 'https://evil.example.com/x' } }],
    }));
    expect(() => loadFileConfig()).toThrow(/白名单/);
    process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({
      tools: [{ name: 'noallow', kind: 'http', description: 'd', http: { url: 'https://api.example.com/x' } }],
    }));
    expect(() => loadFileConfig()).toThrow(/allowedHttpHosts/);
  });

  it('形状校验：缺 http / 坏 url / method 白名单外 / http 型带 template / prompt 缺 template 均拒', () => {
    const bad: unknown[] = [
      { name: 'a', kind: 'http', description: 'd' },
      { name: 'a', kind: 'http', description: 'd', http: { url: 'not-a-url' } },
      { name: 'a', kind: 'http', description: 'd', http: { url: 'https://x.example.com/', method: 'TRACE' } },
      { name: 'a', kind: 'http', description: 'd', http: { url: 'https://x.example.com/' }, template: 't' },
      { name: 'a', kind: 'weird', description: 'd' },
      { name: 'a', description: 'd' }, // prompt 缺 template
    ];
    for (const tools of bad) {
      process.env.WATER_CONFIG_FILE = withConfig(JSON.stringify({ allowedHttpHosts: ['x.example.com'], tools: [tools] }));
      expect(() => loadFileConfig(), JSON.stringify(tools)).toThrow();
    }
  });

  it('缺省无 allowedHttpHosts：字段不出现（exactOptionalPropertyTypes 契约）', () => {
    process.env.WATER_CONFIG_FILE = withConfig('{"tools":[{"name":"seal","description":"d","template":"t"}]}');
    expect('allowedHttpHosts' in loadFileConfig()).toBe(false);
  });
});

describe('配置式工具 · http 型执行（M22 configHttpToolToTool）', () => {
  const startServer = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
    new Promise<{ port: number; close: () => Promise<void> }>(resolve => {
      const srv: Server = createServer(handler);
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        resolve({ port, close: () => new Promise(r => srv.close(() => r(null))) });
      });
    });

  it('$参数 与 $env: 单遍插值、header 透传、响应回填；风险恒 high', async () => {
    const seen: { q?: string | null; auth?: string } = {};
    const srv = await startServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      seen.q = u.searchParams.get('q');
      seen.auth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      process.env.WATER_M22_TEST_KEY = 'test-token-xyz';
      const t = configHttpToolToTool({
        name: 'lookup', kind: 'http', description: 'd',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        http: { url: `http://127.0.0.1:${srv.port}/echo?q=$q`, headers: { Authorization: 'Bearer $env:WATER_M22_TEST_KEY' } },
      });
      expect(t.risk).toBe('high');
      expect(t.riskFor?.({})).toBe('high');
      const out = await t.run({ q: 'hello' }, { cwd: '.' });
      expect(out).toContain('HTTP 200');
      expect(out).toContain('"ok":true');
      expect(seen.q).toBe('hello');
      expect(seen.auth).toBe('Bearer test-token-xyz'); // $env: 值来自进程环境，未出现在任何 config
    } finally {
      delete process.env.WATER_M22_TEST_KEY;
      await srv.close();
    }
  });

  it('$env 未设置 → 明确报错；响应超 64KB 被截断', async () => {
    const big = 'x'.repeat(80 * 1024);
    const srv = await startServer((_req, res) => { res.end(big); });
    try {
      delete process.env.WATER_M22_MISSING_KEY;
      const t = configHttpToolToTool({
        name: 'b', kind: 'http', description: 'd',
        http: { url: `http://127.0.0.1:${srv.port}/`, headers: { Authorization: 'Bearer $env:WATER_M22_MISSING_KEY' } },
      });
      await expect(t.run({}, { cwd: '.' })).rejects.toThrow(/WATER_M22_MISSING_KEY/);
      const t2 = configHttpToolToTool({ name: 'c', kind: 'http', description: 'd', http: { url: `http://127.0.0.1:${srv.port}/` } });
      const out = await t2.run({}, { cwd: '.' });
      expect(out.length).toBeLessThan(80 * 1024); // 截断生效
    } finally { await srv.close(); }
  });

  it('超时：服务端挂起时按 timeoutMs 中断（参数化，默认 10s）', async () => {
    const srv = await startServer(() => { /* 挂起不响应 */ });
    try {
      const t = configHttpToolToTool(
        { name: 'slow', kind: 'http', description: 'd', http: { url: `http://127.0.0.1:${srv.port}/` } },
        { timeoutMs: 150 },
      );
      await expect(t.run({}, { cwd: '.' })).rejects.toThrow(/HTTP 调用失败/);
    } finally { await srv.close(); }
  });
});
