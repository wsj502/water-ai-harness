/**
 * M20 CLI 子代理时间线测试：TermRenderer 对 sub_event 的折叠渲染
 * （quiet/非 quiet 双模式；与 Web M18 时间线同语义、终端表达）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TermRenderer } from '../apps/cli/src/render.js';
import type { LoopEvent, ToolUsePart } from '@water/core';

describe('M20 CLI 子代理时间线（TermRenderer）', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('非 quiet：轮次分隔/工具行/结果行按缩进渲染，文本流首块缩进', () => {
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as never);
    const l = vi.spyOn(console, 'log').mockImplementation(((s: string) => { out.push(`${s}\n`); }) as never);
    const r = new TermRenderer({ quiet: false });
    const taskCall: ToolUsePart = { type: 'tool_use', id: 'p1', name: 'task', input: { mode: 'write' } };
    const subCall: ToolUsePart = { type: 'tool_use', id: 'w1', name: 'write', input: { path: 'a.txt' } };
    const evs: LoopEvent[] = [
      { type: 'tool_pending', call: taskCall },
      { type: 'sub_event', callId: 'p1', ev: { type: 'turn_start', turn: 1, model: 'm' } },
      { type: 'sub_event', callId: 'p1', ev: { type: 'text_delta', text: '正在写…' } },
      { type: 'sub_event', callId: 'p1', ev: { type: 'tool_pending', call: subCall } },
      { type: 'sub_event', callId: 'p1', ev: { type: 'tool_result', call: subCall, result: '已写入 a.txt', isError: false, durationMs: 5 } },
      { type: 'sub_event', callId: 'p1', ev: { type: 'finish', reason: 'end' } },
    ];
    for (const ev of evs) r.handle(ev);
    const text = out.join('');
    expect(text).toContain('── 子代理[p1] 第 1 轮 ──');
    expect(text).toContain('⚙ write');
    expect(text).toContain('✓ 5ms');
    expect(text).toContain('已写入 a.txt');
    expect(text).toContain('正在写…');
    w.mockRestore(); l.mockRestore();
  });

  it('quiet：sub_event 完全静默（主循环事件照常）', () => {
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as never);
    const l = vi.spyOn(console, 'log').mockImplementation(((s: string) => { out.push(`${s}\n`); }) as never);
    const r = new TermRenderer({ quiet: true });
    const taskCall: ToolUsePart = { type: 'tool_use', id: 'p1', name: 'task', input: {} };
    r.handle({ type: 'tool_pending', call: taskCall });
    r.handle({ type: 'sub_event', callId: 'p1', ev: { type: 'turn_start', turn: 1, model: 'm' } });
    r.handle({ type: 'sub_event', callId: 'p1', ev: { type: 'text_delta', text: '子代理文本' } });
    const text = out.join('');
    expect(text).toContain('⚙ task');
    expect(text).not.toContain('子代理');
    expect(text).not.toContain('第 1 轮');
    expect(text).not.toContain('子代理文本');
    w.mockRestore(); l.mockRestore();
  });

  it('文本流被后续事件正确收尾（flush 换行），finish 不残留缩进流', () => {
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as never);
    const l = vi.spyOn(console, 'log').mockImplementation (((s: string) => { out.push(`${s}\n`); }) as never);
    const r = new TermRenderer({ quiet: false });
    r.handle({ type: 'sub_event', callId: 'p1', ev: { type: 'text_delta', text: '流式' } });
    r.handle({ type: 'sub_event', callId: 'p1', ev: { type: 'tool_result', call: { type: 'tool_use', id: 'w1', name: 'write', input: {} }, result: 'x', isError: false, durationMs: 1 } });
    r.handle({ type: 'finish', reason: 'end' });
    const text = out.join('');
    // 文本流结束后有换行（后续行不黏连）
    expect(text).toMatch(/流式\x1b\[0m\n/);
    w.mockRestore(); l.mockRestore();
  });

  it('M25 显式 quiet 压过 TTY 自动判定：isTTY=true 下 { quiet: true } 仍静默 sub_event', () => {
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as never);
    const l = vi.spyOn(console, 'log').mockImplementation(((s: string) => { out.push(`${s}\n`); }) as never);
    // 构造 TTY 环境（自动判定应判非 quiet）；显式 quiet 必须赢——这是 --quiet flag 的契约
    // （vitest 管道环境里 isTTY 属性不存在，vi.spyOn getter 挂不上，用 defineProperty 直改）
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const r = new TermRenderer({ quiet: true });
    const taskCall: ToolUsePart = { type: 'tool_use', id: 'p1', name: 'task', input: {} };
    r.handle({ type: 'tool_pending', call: taskCall });
    r.handle({ type: 'sub_event', callId: 'p1', ev: { type: 'turn_start', turn: 1, model: 'm' } });
    r.handle({ type: 'sub_event', callId: 'p1', ev: { type: 'text_delta', text: '子代理文本' } });
    const text = out.join('');
    expect(text).toContain('⚙ task');          // 主循环事件照常
    expect(text).not.toContain('子代理文本');   // 子代理过程静默
    expect(text).not.toContain('第 1 轮');
    if (orig) Object.defineProperty(process.stdout, 'isTTY', orig);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    w.mockRestore(); l.mockRestore();
  });

  it('M25 缺省时维持 TTY 自动判定：isTTY=true 且未传 quiet → sub_event 照常渲染', () => {
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(s); return true; }) as never);
    const l = vi.spyOn(console, 'log').mockImplementation(((s: string) => { out.push(`${s}\n`); }) as never);
    const orig = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const r = new TermRenderer(); // 缺省：交给自动判定（TTY → 非 quiet）
    r.handle({ type: 'sub_event', callId: 'p1', ev: { type: 'turn_start', turn: 1, model: 'm' } });
    const text = out.join('');
    expect(text).toContain('子代理[p1]');
    if (orig) Object.defineProperty(process.stdout, 'isTTY', orig);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    w.mockRestore(); l.mockRestore();
  });
});
