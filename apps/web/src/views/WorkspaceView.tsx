import { useEffect, useState } from 'react';
import { api, type FileNode } from '../api';

function TreeNode({ node, depth, selected, onSelect }: {
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  return (
    <>
      <div
        className={`node${selected === node.path ? ' sel' : ''}`}
        onClick={() => node.dir ? setExpanded(!expanded) : onSelect(node.path)}
      >
        <span className="tw">{node.dir ? (expanded ? '▾' : '▸') : ''}</span>
        {node.dir ? '📁' : '📄'} {node.name}
      </div>
      {node.dir && expanded && node.children && (
        <div className="children">
          {node.children.map(c => (
            <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </>
  );
}

/** 工作区页：文件树 + 内容预览，接 /api/files/* 真实数据 */
export function WorkspaceView() {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [root, setRoot] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fileTree().then(r => { setTree(r.tree); setRoot(r.root); }).catch(e => setError(String(e)));
  }, []);

  const open = (p: string) => {
    setSelected(p);
    setContent(null);
    api.fileContent(p).then(r => setContent(r.content)).catch(e => setContent(`（读取失败：${e}）`));
  };

  return (
    <main className="main" style={{ gridArea: 'main' }}>
      <div className="ws-wrap">
        <div className="ws-tree">
          <div className="meta-line">{root}</div>
          {error && <div style={{ color: 'var(--red)', fontSize: 12, padding: 8 }}>{error}</div>}
          {tree.map(n => (
            <TreeNode key={n.path} node={n} depth={0} selected={selected} onSelect={open} />
          ))}
        </div>
        <div className="ws-file">
          <div className="filebar">
            {selected
              ? <span className="path"><b>{selected}</b></span>
              : <span style={{ color: 'var(--text-2)' }}>点击左侧文件预览</span>}
          </div>
          <div className="code-scroll">
            {content !== null && (
              <div className="codeblock" style={{ padding: '12px 16px' }}>
                {content.split('\n').map((line, i) => (
                  <div className="ln" key={i}>
                    <span className="no">{i + 1}</span>
                    <span className="tx">{line || ' '}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
