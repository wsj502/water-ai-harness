/**
 * M3 离线测试：markdown 解析器（含 XSS 安全性）+ 行级 diff。
 *
 * 运行：npx tsx scripts/test-web-pure.ts
 *
 * 安全要点：解析器输出结构化 Inline（React 文本节点），模型产出的任何
 * HTML 都只会成为 text——不存在 innerHTML，因此没有注入面。这里的断言
 * 固化这一契约。
 */
import { parseInline, parseMarkdown } from '../apps/web/src/markdown';
import { diffStats, lineDiff } from '../apps/web/src/diff';

let failed = 0;
function ok(cond: boolean, name: string, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failed++; console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

console.log('--- markdown 块级 ---');
{
  const b = parseMarkdown('# 标题\n\n段落一\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用行');
  ok(b[0]!.kind === 'heading' && b[0]!.kind === 'heading' && (b[0] as { level: number }).level === 1, '标题');
  ok(b[1]!.kind === 'para', '段落');
  const code = b.find(x => x.kind === 'code');
  ok(code?.kind === 'code' && code.lang === 'ts' && code.lines.length === 2, 'fenced code 带语言与行');
  const ul = b.find(x => x.kind === 'list' && !x.ordered);
  ok(ul?.kind === 'list' && ul.items.length === 2, '无序列表 2 项');
  const ol = b.find(x => x.kind === 'list' && x.ordered);
  ok(ol?.kind === 'list' && ol.items.length === 2, '有序列表 2 项');
  ok(b.at(-1)!.kind === 'quote', '引用块');
}
{
  // 未闭合的代码围栏：容错到 EOF
  const b = parseMarkdown('```\nabc');
  ok(b[0]!.kind === 'code' && (b[0] as { lines: string[] }).lines[0] === 'abc', '未闭合围栏容错');
}

console.log('--- markdown 行内 ---');
{
  const i1 = parseInline('先 `code` 后**粗**和*斜*');
  ok(i1.some(x => x.t === 'code' && x.v === 'code'), '行内 code');
  ok(i1.some(x => x.t === 'strong'), '粗体');
  ok(i1.some(x => x.t === 'em'), '斜体');
  ok(i1.some(x => x.t === 'text' && x.v.includes('先')), '普通文本');

  const i2 = parseInline('见 [文档](https://example.com) 与 [危险](javascript:alert(1))');
  const link = i2.find(x => x.t === 'link');
  ok(link?.t === 'link' && link.href === 'https://example.com', 'http 链接保留');
  ok(!i2.some(x => x.t === 'link' && x.href.startsWith('javascript')), 'javascript: 链接被降级');

  const i3 = parseInline('`**不格式化**`');
  ok(i3.length === 1 && i3[0]!.t === 'code' && i3[0]!.v === '**不格式化**', 'code span 内不格式化');
}

console.log('--- XSS 契约 ---');
{
  const i = parseInline('<script>alert(1)</script> <img src=x onerror=alert(2)>');
  ok(i.every(x => x.t === 'text'), 'HTML 标签全部落为 text 节点（React 文本渲染，无 innerHTML）');
  const joined = i.map(x => (x as { v: string }).v).join('');
  ok(joined.includes('<script>'), '原文保留（用户可见发生了什么，而非静默丢弃）');
  ok(!i.some(x => x.t === 'link'), '无链接注入');
}

console.log('--- 行级 diff ---');
{
  const d = lineDiff('a\nb\nc\nd', 'a\nx\nc\nd');
  const types = d.map(l => l.type).join(',');
  ok(types === 'ctx,del,add,ctx,ctx', `替换一行 → ctx,del,add,ctx,ctx（实际 ${types}）`);
  const st = diffStats(d);
  ok(st.add === 1 && st.del === 1, '统计 +1 −1');
}
{
  const d = lineDiff('a\nb', 'a\nb\nc');
  ok(d.at(-1)!.type === 'add' && d.at(-1)!.text === 'c', '纯新增行');
  const d2 = lineDiff('a\nb\nc', 'a\nb');
  ok(d2.at(-1)!.type === 'del' && d2.at(-1)!.text === 'c', '纯删除行');
  const d3 = lineDiff('same', 'same');
  ok(d3.length === 1 && d3[0]!.type === 'ctx', '无变化全 ctx');
}

console.log(`\n${failed === 0 ? '✅ M3 markdown/diff 测试 PASS' : `❌ FAIL（${failed} 项）`}`);
if (failed > 0) process.exit(1);
