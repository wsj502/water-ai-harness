/**
 * HTTP 容错网关（M2）：可重试状态 + 指数退避 + 超时。
 *
 * 关键纪律：
 * 1. 只在「流的首帧之前」重试——一旦吐过 token 给调用方，重试意味着
 *    重复输出，绝不能做（重试因此收敛在建立连接这一步）；
 * 2. 用户主动中断（AbortError）不重试——那不是故障，是意图；
 * 3. 尊重 Retry-After 头，退避基线 1s/2s/4s，最多 3 次。
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

export interface FetchWithRetryOptions {
  maxRetries?: number;   // 默认 3
  timeoutMs?: number;    // 默认 120_000
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 带重试的 fetch：返回成功建立的响应（状态码 >=200 <300 之外的也返回，
 * 由调用方决定——只有「可重试状态」才在这里消化）。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let attempt = 0;

  for (;;) {
    // 每次尝试独立超时；与调用方信号合并（Node 22+ 支持 AbortSignal.any）
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      const resp = await fetch(url, { ...init, signal });
      if (!RETRYABLE_STATUS.has(resp.status) || attempt >= maxRetries) return resp;
      // 释放失败响应的连接再退避
      await resp.body?.cancel().catch(() => {});
      const retryAfter = Number(resp.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : 2 ** attempt * 1000;
      console.warn(`[provider] HTTP ${resp.status}，${delay}ms 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
      attempt++;
      await sleep(delay);
    } catch (e) {
      // 用户中断/超时直接抛出（TimeoutError 语义等同失败，不重试超时本身；
      // 网络级错误在未达上限时重试）
      if (opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
      if (attempt >= maxRetries) throw e;
      const delay = 2 ** attempt * 1000;
      console.warn(`[provider] 网络错误（${e instanceof Error ? e.message : String(e)}），${delay}ms 后重试（第 ${attempt + 1}/${maxRetries} 次）`);
      attempt++;
      await sleep(delay);
    }
  }
}
