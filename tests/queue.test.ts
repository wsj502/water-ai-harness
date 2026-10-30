/**
 * M14 排队闸门单测：Session.enqueueTurn 的顺序/计数/链式释放（确定性，不依赖网络竞态）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../apps/server/src/session.js';
import { ParallelGate } from '../apps/server/src/gate.js';
import type { ToolUsePart } from '@water/core';

afterEach(() => { vi.useRealTimers(); });

describe('M14 enqueueTurn（消息排队闸门）', () => {
  it('按到达顺序获得执行权；waiters 计数正确', async () => {
    const s = new Session('sq');
    const t1 = s.enqueueTurn();
    const t2 = s.enqueueTurn();
    const t3 = s.enqueueTurn();
    expect([t1.position, t2.position, t3.position]).toEqual([0, 1, 2]);
    expect(s.waiters).toBe(3);

    const order: number[] = [];
    const run2 = (async () => { await t2.wait(); order.push(2); t2.release(); })();
    const run3 = (async () => { await t3.wait(); order.push(3); t3.release(); })();

    order.push(1);
    t1.release();
    await run2;
    await run3;
    expect(order).toEqual([1, 2, 3]);
    expect(s.waiters).toBe(0);
  });

  it('中途放弃（release 未 wait）不阻塞后来者', async () => {
    const s = new Session('sq2');
    const t1 = s.enqueueTurn();
    const t2 = s.enqueueTurn();
    t1.release();      // 第一个立即放行
    t2.release();      // 第二个未等待直接放弃
    const t3 = s.enqueueTurn();
    await t3.wait();   // 立即可执行（链已被释放）
    t3.release();
    expect(s.waiters).toBe(0);
  });
});

describe('M16 ParallelGate（跨会话并行闸门）', () => {
  it('未满直接进入；满后 FIFO 排队，释放即把槽位转交队首', async () => {
    const g = new ParallelGate(2);
    const a = g.acquire();
    const b = g.acquire();
    expect(a.queued).toBe(false);
    expect(b.queued).toBe(false);
    expect(g.running).toBe(2);

    const c = g.acquire();
    const d = g.acquire();
    expect(c.queued).toBe(true);
    expect(d.queued).toBe(true);
    expect([c.position, d.position]).toEqual([0, 1]);

    const granted: string[] = [];
    void c.ready.then(() => granted.push('c'));
    void d.ready.then(() => granted.push('d'));
    a.release(); // 槽位转交 c（running 不变）
    await new Promise(r => setTimeout(r, 0));
    expect(granted).toEqual(['c']);
    expect(g.running).toBe(2); // b + c
    b.release(); // 转交 d
    await new Promise(r => setTimeout(r, 0));
    expect(granted).toEqual(['c', 'd']);
    c.release();
    d.release();
    expect(g.running).toBe(0);
    expect(g.queuedCount).toBe(0);
  });

  it('排队中放弃（release 早于获得槽位）：只撤回自己的号，不误伤队首', async () => {
    const g = new ParallelGate(1);
    const a = g.acquire();
    const b = g.acquire(); // 排队
    const c = g.acquire(); // 排队
    b.release();           // 放弃：从等待队列移除 b 自己
    const granted: string[] = [];
    void c.ready.then(() => granted.push('c'));
    a.release();           // 槽位应转交 c（而非已放弃的 b）
    await new Promise(r => setTimeout(r, 0));
    expect(granted).toEqual(['c']);
    expect(g.running).toBe(1);
    c.release();
    expect(g.running).toBe(0);
  });

  it('重复 release 幂等：不重复转交、不重复扣减', async () => {
    const g = new ParallelGate(1);
    const a = g.acquire();
    const b = g.acquire();
    a.release();
    a.release(); // 重复释放：第二次必须是空操作
    await new Promise(r => setTimeout(r, 0));
    expect(g.running).toBe(1); // b 持有
    b.release();
    expect(g.running).toBe(0);
  });
});

describe('M16 并发正确性（按会话隔离）', () => {
  const call = (id: string): ToolUsePart =>
    ({ type: 'tool_use', id, name: 'write', input: { path: 'x' } }) as ToolUsePart;

  it('审批 pending 按会话隔离：A 的拒绝/放行不影响 B 的悬挂审批', async () => {
    const a = new Session('m16a');
    const b = new Session('m16b');
    const pa = a.waitApproval(call('x1'));
    const pb = b.waitApproval(call('x2'));
    expect([a.pendingCount, b.pendingCount]).toEqual([1, 1]);
    a.resolveApproval('x1', 'deny');
    await expect(pa).resolves.toBe('deny');
    expect(b.pendingCount).toBe(1); // B 仍悬挂，未被 A 的动作波及
    b.resolveApproval('x2', 'once');
    await expect(pb).resolves.toBe('once');
    expect(b.pendingCount).toBe(0);
  });

  it('事件回放缓冲每会话独立：reset 只清空自己的', () => {
    const a = new Session('m16c');
    const b = new Session('m16d');
    a.recordEvent({ type: 'turn_start', turn: 1, model: 'm' });
    b.recordEvent({ type: 'turn_start', turn: 1, model: 'm' });
    b.recordEvent({ type: 'text_delta', text: 'hi' });
    a.resetEventBuffer();
    expect(a.eventsSince(0)).toEqual([]);
    expect(b.eventsSince(0).length).toBe(2); // B 的回放完好
  });
});

describe('M19 断开宽限（Session 宽限状态机）', () => {
  it('beginGrace 超时触发 onExpire；notifyReconnect 取消倒计时', () => {
    vi.useFakeTimers();
    const s = new Session('m19a');
    const expired: number[] = [];
    s.beginGrace(1000, () => expired.push(1));
    vi.advanceTimersByTime(999);
    expect(expired).toEqual([]);
    s.notifyReconnect(); // 宽限期内重连：倒计时取消
    vi.advanceTimersByTime(5000);
    expect(expired).toEqual([]);
    s.beginGrace(1000, () => expired.push(2));
    vi.advanceTimersByTime(1000);
    expect(expired).toEqual([2]); // 未重连 → 超时触发（中断 Loop + 全拒的回调语义）
  });

  it('cancelGrace 幂等；重复 beginGrace 以最后一次为准', () => {
    vi.useFakeTimers();
    const s = new Session('m19b');
    const fired: number[] = [];
    s.beginGrace(100, () => fired.push(1));
    s.beginGrace(100, () => fired.push(2));
    s.cancelGrace();
    s.cancelGrace();
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });
});
