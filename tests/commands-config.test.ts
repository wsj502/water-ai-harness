/**
 * M13 配置式命令测试：解析/校验/红线（WATER_CONFIG_FILE 注入测试路径）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadFileConfig } from '../packages/core/src/index.js';

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
