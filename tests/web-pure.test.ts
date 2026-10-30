/**
 * markdown 解析器（含 XSS 契约）+ 行级 diff（迁移自 scripts/test-web-pure.ts）。
 */
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../apps/web/src/markdown';
import { diffStats, lineDiff } from '../apps/web/src/diff';
import { applyEvent, type UiBlock } from '../apps/web/src/state/blocks';
import type { ServerEvent } from '../apps/web/src/api';
import type { ToolUsePart } from '@water/core';

describe('markdown 块级', () => {
  const b = parseMarkdown('# 标题\n\n段落一\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用行');

  it('标题', () => expect(b[0]).toMatchObject({ kind: 'heading', level: 1 }));
  it('段落', () => expect(b[1]).toMatchObject({ kind: 'para' }));
  it('fenced code 带语言与行', () => {
    const code = b.find(x => x.kind === 'code');
    expect(code).toMatchObject({ kind: 'code', lang: 'ts' });
    expect(code!.kind === 'code' && code!.lines).toHaveLength(2);
  });
  it('无序/有序列表', () => {
    expect(b.find(x => x.kind === 'list' && !x.ordered)).toMatchObject({ kind: 'list' });
    expect(b.find(x => x.kind === 'list' && x.ordered)).toMatchObject({ kind: 'list' });
  });
  it('引用块', () => expect(b.at(-1)).toMatchObject({ kind: 'quote' }));
  it('未闭合围栏容错到 EOF', () => {
    const r = parseMarkdown('```\nabc');
    expect(r[0]).toMatchObject({ kind: 'code' });
  });
});

describe('markdown 行内', () => {
  it('code/粗/斜/文本并存', () => {
    const i = parseInline('先 `code` 后**粗**和*斜*');
    expect(i.some(x => x.t === 'code' && x.v === 'code')).toBe(true);
    expect(i.some(x => x.t === 'strong')).toBe(true);
    expect(i.some(x => x.t === 'em')).toBe(true);
    expect(i.some(x => x.t === 'text' && x.v.includes('先'))).toBe(true);
  });
  it('http 链接保留、javascript: 降级', () => {
    const i = parseInline('见 [文档](https://example.com) 与 [危险](javascript:alert(1))');
    expect(i.find(x => x.t === 'link')).toMatchObject({ t: 'link', href: 'https://example.com' });
    expect(i.some(x => x.t === 'link' && x.href.startsWith('javascript'))).toBe(false);
  });
  it('code span 内不格式化', () => {
    const i = parseInline('`**不格式化**`');
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({ t: 'code', v: '**不格式化**' });
  });
});

describe('XSS 契约（架构保证，非过滤保证）', () => {
  it('HTML 标签全部落为 text 节点（React 文本渲染，无 innerHTML）', () => {
    const i = parseInline('<script>alert(1)</script> <img src=x onerror=alert(2)>');
    expect(i.every(x => x.t === 'text')).toBe(true);
    const joined = i.map(x => (x as { v: string }).v).join('');
    expect(joined).toContain('<script>');
    expect(i.some(x => x.t === 'link')).toBe(false);
  });
});

describe('行级 diff', () => {
  it('替换一行 → ctx,del,add,ctx,ctx', () => {
    const d = lineDiff('a\nb\nc\nd', 'a\nx\nc\nd');
    expect(d.map(l => l.type).join(',')).toBe('ctx,del,add,ctx,ctx');
    expect(diffStats(d)).toEqual({ add: 1, del: 1 });
  });
  it('纯增/纯删/无变化', () => {
    expect(lineDiff('a\nb', 'a\nb\nc').at(-1)).toMatchObject({ type: 'add', text: 'c' });
    expect(lineDiff('a\nb\nc', 'a\nb').at(-1)).toMatchObject({ type: 'del', text: 'c' });
    expect(lineDiff('same', 'same')).toEqual([{ type: 'ctx', text: 'same' }]);
  });
});

describe('子代理时间线折叠（M18 blocks）', () => {
  const taskCall: ToolUsePart = { type: 'tool_use', id: 't1', name: 'task', input: { mode: 'write' } };
  const subWrite: ToolUsePart = { type: 'tool_use', id: 'w1', name: 'write', input: { path: 'a.txt' } };
  const toolBlock = (bs: UiBlock[]) => bs[0] as Extract<UiBlock, { kind: 'tool' }>;

  /** M18 场景帧序列：轮1 文本+子工具（审批→获批→落盘），轮2 文本收尾 */
  const frames: ServerEvent[] = [
    { type: 'tool_pending', call: taskCall },
    { type: 'sub_event', callId: 't1', ev: { type: 'turn_start', turn: 1, model: 'm' } },
    { type: 'sub_event', callId: 't1', ev: { type: 'text_delta', text: '正在处理…' } },
    { type: 'sub_event', callId: 't1', ev: { type: 'tool_pending', call: subWrite } },
    { type: 'sub_event', callId: 't1', ev: { type: 'approval_required', callId: 't1:w1', call: subWrite } },
    { type: 'sub_event', callId: 't1', ev: { type: 'tool_approved', call: subWrite, scope: 'once' } },
    { type: 'sub_event', callId: 't1', ev: { type: 'tool_result', call: subWrite, result: '已写入 a.txt', isError: false, durationMs: 3 } },
    { type: 'sub_event', callId: 't1', ev: { type: 'turn_start', turn: 2, model: 'm' } },
    { type: 'sub_event', callId: 't1', ev: { type: 'text_delta', text: '完成' } },
    { type: 'sub_event', callId: 't1', ev: { type: 'finish', reason: 'end' } },
  ];
  const fold = (evs: ServerEvent[]) => evs.reduce<UiBlock[]>((bs, ev) => applyEvent(bs, ev), []);

  it('轮次分组与节点收拢：文本→工具(running→done)→审批(waiting→approved)→次轮文本', () => {
    const b = toolBlock(fold(frames));
    expect(b.subTimeline).toHaveLength(2);
    const [g1, g2] = b.subTimeline!;
    expect(g1.turn).toBe(1);
    expect(g1.nodes.map(n => n.kind)).toEqual(['text', 'tool', 'approval']);
    expect(g1.nodes[1]).toMatchObject({ kind: 'tool', name: 'write', summary: 'a.txt', status: 'done', result: '已写入 a.txt' });
    expect(g1.nodes[2]).toMatchObject({ kind: 'approval', fullId: 't1:w1', summary: 'a.txt', status: 'approved' });
    expect(g2.turn).toBe(2);
    expect(g2.nodes).toEqual([{ kind: 'text', text: '完成' }]);
  });

  it('拒绝路径：tool_denied → 工具节点 denied、审批节点 denied', () => {
    const denyFrames: ServerEvent[] = [
      { type: 'tool_pending', call: taskCall },
      { type: 'sub_event', callId: 't1', ev: { type: 'turn_start', turn: 1, model: 'm' } },
      { type: 'sub_event', callId: 't1', ev: { type: 'tool_pending', call: subWrite } },
      { type: 'sub_event', callId: 't1', ev: { type: 'approval_required', callId: 't1:w1', call: subWrite } },
      { type: 'sub_event', callId: 't1', ev: { type: 'tool_denied', call: subWrite } },
    ];
    const b = toolBlock(fold(denyFrames));
    const turn = b.subTimeline![0]!;
    expect(turn.nodes[0]).toMatchObject({ kind: 'tool', status: 'denied' });
    expect(turn.nodes[1]).toMatchObject({ kind: 'approval', status: 'denied' });
  });

  it('直播与回放同构：同一帧序列从空折叠两次，结果完全一致（回放 ?since= 重建同一时间线）', () => {
    expect(fold(frames)).toEqual(fold(frames));
  });
});
