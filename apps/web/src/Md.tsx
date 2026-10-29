/**
 * Md 渲染组件（M3）：markdown.ts 的块结构 → React 元素。
 * 全程不碰 innerHTML / dangerouslySetInnerHTML——XSS 免疫是架构保证，不是过滤保证。
 */
import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Inline, type MdBlock } from './markdown';

function renderInline(nodes: Inline[], keyBase: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyBase}-${i}`;
    switch (n.t) {
      case 'text': return <Fragment key={key}>{n.v}</Fragment>;
      case 'code': return <code key={key} className="md-code">{n.v}</code>;
      case 'strong': return <strong key={key}>{renderInline(n.v, key)}</strong>;
      case 'em': return <em key={key}>{renderInline(n.v, key)}</em>;
      case 'link':
        return <a key={key} href={n.href} target="_blank" rel="noopener noreferrer">{n.v}</a>;
    }
  });
}

function Block({ b, idx }: { b: MdBlock; idx: number }) {
  switch (b.kind) {
    case 'code':
      return (
        <div className="codeblock md-fence">
          {b.lang && <div className="lang">{b.lang}</div>}
          {b.lines.map((l, i) => (
            <div className="ln" key={i}><span className="no">{i + 1}</span><span className="tx">{l || ' '}</span></div>
          ))}
        </div>
      );
    case 'heading': {
      const Tag = (Math.min(b.level + 2, 6) === 3 ? 'h3' : Math.min(b.level + 2, 6) === 4 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
      return <Tag className="md-h">{b.text}</Tag>;
    }
    case 'para':
      return <p className="md-p">{renderInline(b.inlines, `p${idx}`)}</p>;
    case 'list': {
      const List = b.ordered ? 'ol' : 'ul';
      return (
        <List className="md-list">
          {b.items.map((it, i) => <li key={i}>{renderInline(it, `l${idx}-${i}`)}</li>)}
        </List>
      );
    }
    case 'quote':
      return <blockquote className="md-quote">{b.lines.join('\n')}</blockquote>;
  }
}

/** 聊天流里的 markdown 渲染入口（assistant 文本块） */
export function Md({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return <div className="md">{blocks.map((b, i) => <Block key={i} b={b} idx={i} />)}</div>;
}
