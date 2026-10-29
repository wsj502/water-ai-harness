/**
 * 极简 SSE 解析器：把 fetch Response 的 body 解析成 { event, data } 对。
 * 两家厂商都用 SSE，差别只在 data 里的 JSON 结构。
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        let event = 'message';
        const dataLines: string[] = [];
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          // 忽略 id: / retry: / 注释行
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
