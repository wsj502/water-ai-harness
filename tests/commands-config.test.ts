/**
 * M13 配置式命令测试：解析/校验/红线（WATER_CONFIG_FILE 注入测试路径）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configToolToTool, loadFileConfig } from '../packages/core/src/index.js';

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
