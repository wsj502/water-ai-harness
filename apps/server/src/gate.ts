/**
 * M16 全局并行闸门：跨会话并发上限（WATER_MAX_PARALLEL_SESSIONS，默认 3）。
 *
 * 语义：会话间并行、会话内串行（M14 enqueueTurn 不变）；全局活跃数达上限后，
 * 新会话的消息 FIFO 跨会话排队——持有者释放时槽位直接转交队首（不经历空窗）。
 * 与 M14 同构的「排队期间可放弃」：未获得槽位也可 release（只撤回自己的号，
 * 不影响他人；幂等，重复 release 为空操作）。
 */

export interface GateSlot {
  /** true = 获取时已满，正在排队；position = 前面还排着几个 */
  queued: boolean;
  position: number;
  ready: Promise<void>;
  release: () => void;
}

export class ParallelGate {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get running(): number { return this.active; }
  get queuedCount(): number { return this.waiters.length; }

  acquire(): GateSlot {
    if (this.active < this.limit) {
      this.active++;
      let released = false;
      return {
        queued: false, position: 0, ready: Promise.resolve(),
        release: () => {
          if (released) return;
          released = true;
          const next = this.waiters.shift();
          if (next) next();        // 槽位转交队首：active 不变
          else this.active--;
        },
      };
    }
    let grant!: () => void;
    const ready = new Promise<void>(r => { grant = r; });
    const position = this.waiters.length;
    this.waiters.push(grant);
    let released = false;
    return {
      queued: true, position, ready,
      release: () => {
        if (released) return;
        released = true;
        const i = this.waiters.indexOf(grant);
        if (i >= 0) {
          this.waiters.splice(i, 1); // 尚在排队：撤回自己的号（他人不受影响）
        } else {
          const next = this.waiters.shift();
          if (next) next();          // 已被转交持有：继续转交队首
          else this.active--;
        }
      },
    };
  }
}
