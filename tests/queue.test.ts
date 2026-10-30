/**
 * M14 排队闸门单测：Session.enqueueTurn 的顺序/计数/链式释放（确定性，不依赖网络竞态）。
 */
import { describe, expect, it } from 'vitest';
import { Session } from '../apps/server/src/session.js';

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
