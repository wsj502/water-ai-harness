/**
 * markdown 解析器（含 XSS 契约）+ 行级 diff（迁移自 scripts/test-web-pure.ts）。
 */
import { describe, expect, it, vi } from 'vitest';
import { parseInline, parseMarkdown } from '../apps/web/src/markdown';
import { diffStats, lineDiff } from '../apps/web/src/diff';
import { applyEvent, type UiBlock } from '../apps/web/src/state/blocks';
import { withStartupRetry } from '../apps/web/src/api';
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

  it('直播与回放同构：同一帧序列从空折叠两次，结构完全一致（回放 ?since= 重建同一时间线）', () => {
    // 剥离 ts（wall-clock 时间戳不属于「结构」）——不剥离的话两次折叠偶发差 1ms，
    // 本地 Windows 曾侥幸同毫秒通过、CI ubuntu 上翻车：同构断言比结构不比钟表
    const stripTs = (bs: UiBlock[]) => bs.map(b => ({ ...b, ts: undefined }));
    expect(stripTs(fold(frames))).toEqual(stripTs(fold(frames)));
  });
});

describe('#113 乱序容错：approval_required 先于 tool_pending（server 审批桥抢序）', () => {
  const writeCall: ToolUsePart = { type: 'tool_use', id: 'c1', name: 'write', input: { path: 'a.txt' } };

  it('审批帧先到 → 创建 waiting 占位块（审批卡有处渲染）；tool_pending 后到 → 复用不重复', () => {
    let bs = applyEvent([], { type: 'approval_required', callId: 'c1', call: writeCall });
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ kind: 'tool', status: 'waiting' });
    bs = applyEvent(bs, { type: 'tool_pending', call: writeCall });
    expect(bs.filter(b => b.kind === 'tool')).toHaveLength(1);
    expect(bs[0]).toMatchObject({ kind: 'tool', status: 'waiting' });
  });

  it('占位块全生命周期：approved → running、result → done（与正序折叠同构）', () => {
    let bs: UiBlock[] = [];
    bs = applyEvent(bs, { type: 'approval_required', callId: 'c1', call: writeCall });
    bs = applyEvent(bs, { type: 'tool_pending', call: writeCall });
    bs = applyEvent(bs, { type: 'tool_approved', call: writeCall, scope: 'once' });
    expect(bs[0]).toMatchObject({ kind: 'tool', status: 'running' });
    bs = applyEvent(bs, { type: 'tool_result', call: writeCall, result: '已写入', isError: false, durationMs: 5 });
    expect(bs[0]).toMatchObject({ kind: 'tool', status: 'done', result: '已写入' });
  });

  it('拒绝路径：tool_denied 收拢占位块为 denied', () => {
    let bs: UiBlock[] = [];
    bs = applyEvent(bs, { type: 'approval_required', callId: 'c1', call: writeCall });
    bs = applyEvent(bs, { type: 'tool_pending', call: writeCall });
    bs = applyEvent(bs, { type: 'tool_denied', call: writeCall });
    expect(bs[0]).toMatchObject({ kind: 'tool', status: 'denied' });
  });

  it('正序（tool_pending → approval_required）行为不变：running → waiting', () => {
    let bs = applyEvent([], { type: 'tool_pending', call: writeCall });
    expect(bs[0]).toMatchObject({ kind: 'tool', status: 'running' });
    bs = applyEvent(bs, { type: 'approval_required', callId: 'c1', call: writeCall });
    expect(bs).toHaveLength(1);
    expect(bs[0]).toMatchObject({ kind: 'tool', status: 'waiting' });
  });
});

describe('#106 finish 结局渲染（静默死亡修复——聊天区必须能看到结局）', () => {
  it('error → ❌ 通知，含原始 message', () => {
    const bs = applyEvent([], { type: 'finish', reason: 'error', message: 'network error: connection reset' } as ServerEvent);
    expect(bs.at(-1)).toMatchObject({ kind: 'notice' });
    expect(bs.at(-1)!.kind === 'notice' && bs.at(-1)!.text).toContain('connection reset');
  });
  it('max_turns → ⚠️ 轮次上限通知', () => {
    const bs = applyEvent([], { type: 'finish', reason: 'max_turns' } as ServerEvent);
    expect(bs.at(-1)!.kind === 'notice' && bs.at(-1)!.text).toContain('轮次上限');
  });
  it('aborted → ⏹ 中断通知', () => {
    const bs = applyEvent([], { type: 'finish', reason: 'aborted' } as ServerEvent);
    expect(bs.at(-1)!.kind === 'notice' && bs.at(-1)!.text).toContain('中断');
  });
  it('正常结束（end）→ 零通知，不占版面', () => {
    const bs = applyEvent([], { type: 'finish', reason: 'end' } as ServerEvent);
    expect(bs).toHaveLength(0);
  });
});

describe('#115 启动期指数退避重试（desktop 冷启动竞态）', () => {
  it('前 N-1 次失败后成功 → 返回值透传、重试次数正确（sidecar 慢启动场景）', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fn = async (): Promise<string> => { if (++n < 3) throw new Error('EADDRNOTAVAIL'); return 'up'; };
      const p = withStartupRetry(fn, 6, 100);
      const assertion = p.then(v => { expect(v).toBe('up'); expect(n).toBe(3); });
      await vi.runAllTimersAsync();
      await assertion;
    } finally { vi.useRealTimers(); }
  });

  it('连续失败直到上限 → 抛最后一次错误（彻底降级才给横幅）', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fn = async (): Promise<never> => { n++; throw new Error(`boom-${n}`); };
      const p = withStartupRetry(fn, 3, 50);
      const assertion = p.catch((e: Error) => { expect(e.message).toBe('boom-3'); expect(n).toBe(3); return 'caught'; });
      await vi.runAllTimersAsync();
      expect(await assertion).toBe('caught');
    } finally { vi.useRealTimers(); }
  });

  it('退避间隔指数增长（100/200/400）', async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      let virtualNow = 0;
      const fn = async (): Promise<string> => {
        calls.push(virtualNow);
        if (calls.length < 4) throw new Error('x');
        return 'ok';
      };
      const p = withStartupRetry(fn, 6, 100);
      const assertion = p.then(v => expect(v).toBe('ok'));
      for (let i = 0; i < 200 && calls.length < 4; i++) {
        virtualNow += 50;
        await vi.advanceTimersByTimeAsync(50);
      }
      await vi.runAllTimersAsync();
      await assertion;
      expect(calls).toEqual([0, 100, 300, 700]); // 立即首发，之后 100/200/400 指数退避
    } finally { vi.useRealTimers(); }
  });
});
