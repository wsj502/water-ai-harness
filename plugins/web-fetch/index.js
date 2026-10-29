/**
 * web-fetch 插件：抓取 URL 并剥离 HTML 返回正文。
 * 声明了 network 权限 —— 加载器会把工具风险级提升为 medium（每次询问）。
 */

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** @type {import('@water/core').PluginModule} */
export default {
  activate(ctx) {
    ctx.registerTool({
      risk: 'low', // 会被加载器按 network 权限提升为 medium
      spec: {
        name: 'fetch_url',
        description: '抓取网页 URL 并返回纯文本正文（自动剥离 HTML）',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'http(s) URL' },
            maxChars: { type: 'number', description: '最多返回字符数，默认 4000' },
          },
          required: ['url'],
        },
      },
      argSummary: i => String(i.url ?? ''),
      async run(input) {
        const url = String(input.url ?? '');
        if (!/^https?:\/\//.test(url)) throw new Error('只允许 http(s) URL');
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'water-plugin-web-fetch/0.1' },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = htmlToText(await resp.text());
        const max = Number(input.maxChars) || 4000;
        return text.length > max ? text.slice(0, max) + `\n…（共 ${text.length} 字符，已截断）` : text;
      },
    });
    ctx.logger.info('web-fetch 插件已激活');
  },
};
