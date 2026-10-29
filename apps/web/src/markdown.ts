/**
 * Markdown 子集解析器（M3）：纯函数，返回结构化块——不是 HTML 字符串。
 *
 * 为什么手写而不用 marked：
 * 1. 模型输出不可信（提示注入可让它产出任意 HTML）。返回 React 元素
 *    从根上免疫 XSS——不存在 innerHTML，就没有注入面；
 * 2. 渲染发生在 Md.tsx（块 → 元素），本模块只做解析，可独立测试；
 * 3. 学习项目调性：协议边界的每一层都值得亲手写一次。
 *
 * 支持子集（渐进增强，不支持的语法按原文显示）：
 *   fenced code / # 标题 / 无序有序列表 / > 引用 / 段落
 *   行内：`code` **粗** *斜* [链接](http(s)://…)（协议白名单，其余降级纯文本）
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'link'; href: string; v: string };

export type MdBlock =
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; lines: string[] };

// ---------- 行内解析 ----------

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/;

/** 安全链接：仅 http/https，其余（javascript:、data: …）一律降级为纯文本 */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/** 解析一段行内文本（code span 优先切分，内部不再做格式） */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  // 1. 先按 `code` 切
  const codeParts = src.split(/`([^`]+)`/);
  for (let i = 0; i < codeParts.length; i++) {
    const part = codeParts[i]!;
    if (i % 2 === 1) { out.push({ t: 'code', v: part }); continue; }
    if (!part) continue;
    // 2. 链接（先于粗斜体，避免 []() 里的 * 误伤）
    let rest = part;
    for (;;) {
      const m = LINK_RE.exec(rest);
      if (!m) break;
      if (m.index > 0) out.push(...parseEmphasis(rest.slice(0, m.index)));
      const href = safeHref(m[2]!);
      if (href) out.push({ t: 'link', href, v: m[1]! || href });
      else out.push({ t: 'text', v: m[0] }); // 不安全协议：整体按文本
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push(...parseEmphasis(rest));
  }
  return out;
}

/** 粗体/斜体（** 先于 *；互不嵌套——子集即可读性优先） */
function parseEmphasis(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'strong', v: [{ t: 'text', v: m[1] }] });
    else out.push({ t: 'em', v: [{ t: 'text', v: m[2]! }] });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out.length ? out : [{ t: 'text', v: src }];
}

// ---------- 块级解析 ----------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+[.)]\s+(.*)$/;

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // 空行
    if (!line.trim()) { i++; continue; }

    // fenced code
    const fence = line.match(/^```\s*(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) { body.push(lines[i]!); i++; }
      i++; // 跳过收尾 ```（缺失则到 EOF，容错）
      blocks.push({ kind: 'code', lang, lines: body });
      continue;
    }

    // 标题
    const h = line.match(HEADING_RE);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1]!.length, text: h[2]!.trim() });
      i++;
      continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    // 列表（同类连续行合并；有序/无序混排各自成块）
    const ul = line.match(UL_RE);
    const ol = line.match(OL_RE);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const itemRe = ordered ? OL_RE : UL_RE;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(itemRe);
        if (!m) {
          // 缩进续行并入上一项
          if (/^\s+\S/.test(lines[i]!) && items.length) {
            items[items.length - 1] = [...items[items.length - 1]!, { t: 'text', v: ' ' + lines[i]!.trim() }];
            i++;
            continue;
          }
          break;
        }
        items.push(parseInline(m[1]!));
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 段落：连续非空、非块级起始行
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim()
      && !/^```/.test(lines[i]!)
      && !HEADING_RE.test(lines[i]!)
      && !UL_RE.test(lines[i]!) && !OL_RE.test(lines[i]!)
      && !/^>\s?/.test(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    if (para.length) blocks.push({ kind: 'para', inlines: parseInline(para.join('\n')) });
  }
  return blocks;
}
