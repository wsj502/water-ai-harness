/**
 * 内置工具：read / write / edit / grep / glob / shell。
 *
 * 每个工具 = spec（发给模型的 schema）+ risk（权限分级）+ run（执行体）。
 * 零外部依赖：grep/glob 都是手写的小实现，够用且是学习重点。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import type { ToolSpec } from '../types.js';
import type { Risk } from '../permissions.js';

export interface ToolContext {
  /** 工作区根目录，所有相对路径都解析到这里 */
  cwd: string;
  /**
   * M8/M12：派生子代理（由 Agent Loop 注入；嵌套子代理内不可用——防递归）。
   * opts.onEvent：子代理事件实时透传回调（streaming）；mode 决定工具集。
   */
  spawnTask?: (prompt: string, opts?: {
    mode?: 'read' | 'write';
    onEvent?: (ev: import('../types.js').LoopEvent) => void;
    /** M15：父级 task 调用的 callId（Loop 内部注入）——子级审批以 `${parentCallId}:${子id}` 命名空间透传 */
    parentCallId?: string;
  }) => Promise<string>;
}

export interface Tool {
  spec: ToolSpec;
  risk: Risk;
  /**
   * M12：按调用实参动态计算风险（缺省用静态 risk）。
   * 例：task 工具 mode=write 时提升为 high（写入需逐次审批）。
   */
  riskFor?(input: Record<string, unknown>): Risk;
  /** 用于权限 key 的参数摘要，如 shell 返回命令串 */
  argSummary(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

function str(v: unknown): string { return typeof v === 'string' ? v : String(v ?? ''); }

/** 路径安全：解析后必须仍在工作区内（防 ../ 逃逸） */
function resolveInCwd(cwd: string, p: string): string {
  const abs = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越出工作区: ${p}`);
  }
  return abs;
}

// ---------- glob 小实现：支持 ** / * / ? ----------

function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i += 2; }
      else { re += '[^/\\\\]*'; i += 1; }
    } else if (c === '?') { re += '[^/\\\\]'; i += 1; }
    else if (c === '{') {
      // {a,b} 交替
      const close = pattern.indexOf('}', i);
      if (close > i) {
        const alts = pattern.slice(i + 1, close).split(',')
          .map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = close + 1;
      } else { re += '\\{'; i += 1; }
    }
    else { re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); i += 1; }
  }
  return new RegExp(`^${re}$`, 'i');
}

async function* walk(dir: string, depth = 8): AsyncGenerator<string> {
  if (depth <= 0) return;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.') && e.name !== '.env') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth - 1);
    else yield full;
  }
}

// ---------- 六个内置工具 ----------

const readTool: Tool = {
  risk: 'low',
  spec: {
    name: 'read',
    description: '读取工作区内文件内容（返回带行号的文本）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的文件路径' },
        offset: { type: 'number', description: '起始行（1 起），可选' },
        limit: { type: 'number', description: '最多读取行数，可选' },
      },
      required: ['path'],
    },
  },
  argSummary: i => str(i.path),
  async run(input, ctx) {
    const abs = resolveInCwd(ctx.cwd, str(input.path));
    const text = await fs.readFile(abs, 'utf8');
    const lines = text.split('\n');
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Number(input.limit) || 2000;
    return lines.slice(offset - 1, offset - 1 + limit)
      .map((l, i) => `${offset + i}: ${l}`).join('\n');
  },
};

const writeTool: Tool = {
  risk: 'medium',
  spec: {
    name: 'write',
    description: '创建或完整覆写工作区内文件',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  argSummary: i => str(i.path),
  async run(input, ctx) {
    const abs = resolveInCwd(ctx.cwd, str(input.path));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, str(input.content), 'utf8');
    return `已写入 ${input.path}（${str(input.content).length} 字符）`;
  },
};

const editTool: Tool = {
  risk: 'medium',
  spec: {
    name: 'edit',
    description: '在文件中精确替换一段文本（old 必须唯一匹配）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string', description: '要被替换的原文' },
        new: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'old', 'new'],
    },
  },
  argSummary: i => str(i.path),
  async run(input, ctx) {
    const abs = resolveInCwd(ctx.cwd, str(input.path));
    const text = await fs.readFile(abs, 'utf8');
    const oldStr = str(input.old), newStr = str(input.new);
    const count = text.split(oldStr).length - 1;
    if (count === 0) throw new Error('old 文本未找到');
    if (count > 1) throw new Error(`old 文本匹配 ${count} 处，需提供更多上下文保证唯一`);
    await fs.writeFile(abs, text.replace(oldStr, newStr), 'utf8');
    return `已编辑 ${input.path}（替换 1 处）`;
  },
};

const grepTool: Tool = {
  risk: 'low',
  spec: {
    name: 'grep',
    description: '在工作区内按正则搜索文件内容，返回 文件:行号:内容',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        include: { type: 'string', description: '文件名过滤 glob，如 *.ts，可选' },
        path: { type: 'string', description: '子目录，可选' },
      },
      required: ['pattern'],
    },
  },
  argSummary: i => str(i.pattern),
  async run(input, ctx) {
    const root = resolveInCwd(ctx.cwd, str(input.path) || '.');
    const re = new RegExp(str(input.pattern), 'i');
    const filter = input.include ? globToRegExp(str(input.include)) : null;
    const hits: string[] = [];
    for await (const file of walk(root)) {
      if (filter && !filter.test(path.basename(file))) continue;
      let text: string;
      try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${path.relative(ctx.cwd, file)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (hits.length >= 50) return hits.join('\n') + '\n... (截断至 50 条)';
        }
      }
    }
    return hits.length ? hits.join('\n') : '（无匹配）';
  },
};

const globTool: Tool = {
  risk: 'low',
  spec: {
    name: 'glob',
    description: '按 glob 模式列出工作区内文件路径，如 **/*.ts',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' } },
      required: ['pattern'],
    },
  },
  argSummary: i => str(i.pattern),
  async run(input, ctx) {
    const re = globToRegExp(str(input.pattern).replace(/\\/g, '/'));
    const out: string[] = [];
    for await (const file of walk(ctx.cwd)) {
      const rel = path.relative(ctx.cwd, file).replace(/\\/g, '/');
      if (re.test(rel)) { out.push(rel); if (out.length >= 200) break; }
    }
    return out.length ? out.join('\n') : '（无匹配）';
  },
};

const shellTool: Tool = {
  risk: 'high',
  spec: {
    name: 'shell',
    description: '在工作区目录执行 shell 命令（Windows PowerShell）',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 60000' },
      },
      required: ['command'],
    },
  },
  argSummary: i => str(i.command),
  run(input, ctx) {
    const command = str(input.command);
    const timeout = Number(input.timeoutMs) || 60_000;
    return new Promise((resolve, reject) => {
      exec(command, { cwd: ctx.cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n').slice(0, 8000);
        if (err) reject(new Error(`exit=${err.code}\n${out}`));
        else resolve(out || '（无输出）');
      });
    });
  },
};

// ---------- M8：只读研究子代理 ----------

const taskTool: Tool = {
  // 只读派生：medium（token 成本）；write 模式经 riskFor 动态提升为 high（写入逐次审批）
  risk: 'medium',
  riskFor: input => (input.mode === 'write' ? 'high' : 'medium'),
  spec: {
    name: 'task',
    description: '派生研究/执行子代理：给它一个自包含的任务问题，它独立完成后返回结论。'
      + 'read 模式（默认）只用 read/grep/glob 调研；write 模式额外可用 write/edit 修改文件（每次调用需审批）。'
      + '子代理不能再派生子代理，最多 10 轮，过程实时透传到工具卡。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务问题（必须自包含：子代理看不到当前对话历史）' },
        description: { type: 'string', description: '一句话任务标题（展示用，可选）' },
        mode: { type: 'string', enum: ['read', 'write'], description: 'read=只读调研（默认）；write=可写执行' },
      },
      required: ['prompt'],
    },
  },
  argSummary: i => `${str(i.mode) === 'write' ? '✏️' : '📖'} ${str(i.description) || str(i.prompt).slice(0, 50)}`,
  async run(input, ctx) {
    if (!ctx.spawnTask) throw new Error('task 工具在此环境不可用（子代理不能再派生子代理）');
    const mode = str(input.mode) === 'write' ? 'write' : 'read';
    return ctx.spawnTask(str(input.prompt), { mode });
  },
};

export const builtinTools: Tool[] = [readTool, writeTool, editTool, grepTool, globTool, shellTool, taskTool];

export function findTool(name: string): Tool | undefined {
  return builtinTools.find(t => t.spec.name === name);
}

// ---------- M17：配置式声明工具（prompt 型） ----------

/**
 * 把 config.json tools[] 条目包装成 Tool（执行语义 = prompt 型，issue #39 定案）：
 * 模型调用 → 模板中 $参数名 替换为入参 → 渲染文本作为 tool_result 返回给模型。
 * 零副作用（不碰文件/网络/命令），风险级 low；与内置/其他声明重名的检查由注册方（server）负责。
 */
export function configToolToTool(ct: import('../config.js').ConfigTool): Tool {
  return {
    risk: 'low',
    spec: {
      name: ct.name,
      description: ct.description,
      inputSchema: ct.parameters ?? { type: 'object', properties: {} },
    },
    argSummary: i => JSON.stringify(i).slice(0, 60),
    run: async input => (ct.template ?? '').replace(/\$(\w+)/g, (_, k: string) => String(input[k] ?? '')),
  };
}

/**
 * M22：把 config.json tools[] 的 http 型条目包装成 Tool——声明式出网调用。
 * 安全模型：域名白名单在启动期由 loadFileConfig 校验（防 SSRF）；凭据只能经 `$env:变量名`
 * 插值（值来自进程环境/DPAPI 注入链路，永不入 config、不 echo 进错误信息）；超时与响应
 * 截断防资源失控；出网是可观测副作用 → 风险级 high（riskFor 恒 high，逐次审批）。
 */
export function configHttpToolToTool(
  ct: import('../config.js').ConfigTool,
  opts: { timeoutMs?: number } = {},
): Tool {
  const h = ct.http!; // loadFileConfig 已校验 http 型必有 http 字段
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    risk: 'high',
    riskFor: () => 'high',
    spec: {
      name: ct.name,
      description: ct.description,
      inputSchema: ct.parameters ?? { type: 'object', properties: {} },
    },
    argSummary: i => JSON.stringify(i).slice(0, 60),
    run: async input => {
      // 单遍插值：$env:VAR（凭据）与 $param（入参）同一正则——避免替换结果被二次解释
      const interpolate = (s: string): string => s.replace(
        /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$(\w+)/g,
        (_m, envName: string | undefined, paramName: string | undefined) => {
          if (envName !== undefined) {
            const v = process.env[envName];
            if (v === undefined) throw new Error(`环境变量 ${envName} 未设置（$env: 插值失败——凭据请在服务端注入后引用）`);
            return v;
          }
          return paramName !== undefined && input[paramName] !== undefined ? String(input[paramName]) : '';
        },
      );
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = interpolate(v);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const resp = await fetch(interpolate(h.url), {
          method: (h.method ?? 'GET').toUpperCase(),
          headers,
          ...(h.body !== undefined ? { body: interpolate(h.body) } : {}),
          signal: ac.signal,
        });
        const text = (await resp.text()).slice(0, 64 * 1024); // 截断：工具结果只是上下文素材
        return `HTTP ${resp.status} ${resp.statusText}\n${text}`;
      } catch (e) {
        throw new Error(`HTTP 调用失败（${h.url.slice(0, 120)}）: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
