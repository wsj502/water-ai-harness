/**
 * 排查智谱 Anthropic 端点的 usage 上报：打印原始 SSE 事件名与 usage 字段。
 * 运行：python tools/envload.py -- npx tsx scripts/debug-usage.ts
 */
const apiKey = process.env.ZHIPU_API_KEY;
if (!apiKey) { console.error('需要 ZHIPU_API_KEY（用 envload 启动）'); process.exit(1); }

const resp = await fetch('https://open.bigmodel.cn/api/anthropic/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify({
    model: 'glm-4.6',
    max_tokens: 32,
    messages: [{ role: 'user', content: '说"你好"两个字' }],
    stream: true,
  }),
});

if (!resp.ok || !resp.body) {
  console.error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  process.exit(1);
}

const reader = resp.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx: number;
  while ((idx = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const lines = frame.split('\n');
    const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() ?? 'message';
    const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
    if (event.includes('usage') || event === 'message_start' || event === 'message_delta' || event === 'message_stop') {
      // 只打印骨架：键名和 usage 部分，不打印内容
      try {
        const j = JSON.parse(data);
        const skeleton = JSON.stringify({
          event,
          keys: Object.keys(j),
          usage: j.usage ?? (j.message as Record<string, unknown>)?.usage ?? null,
        });
        console.log(skeleton);
      } catch { console.log(event, data.slice(0, 120)); }
    }
  }
}
