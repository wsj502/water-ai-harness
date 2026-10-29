import { useEffect, useState } from 'react';
import { api, type FileNode } from '../api';

/** 按扩展名给文件一个图标（原型里手写的那套语义的简化版） */
function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'txt', 'log'].includes(ext)) return '📝';
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return '⚙';
  if (['css', 'scss', 'html'].includes(ext)) return '🎨';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(ext)) return '🖼';
  if (name.startsWith('.') || ['lock'].includes(ext)) return '🔒';
  return '📄';
}

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
        {node.dir ? '📁' : fileIcon(node.name)} {node.name}
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

/** 工作区页：文件树 + 内容预览，接 /api/files/* 真实数据；「在会话中引用」注入 composer */
export function WorkspaceView({ onInject }: { onInject: (text: string) => void }) {
  const [tree, setTree] = useState<FileNode[]>([]);
  const [root, setRoot] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fileTree().then(r => { setTree(r.tree); setRoot(r.root); }).catch(e => setError(String(e)));
  }, []);

  const open = (p: string) => {
    setSelected(p);
    setContent(null);
    setFileSize(null);
    api.fileContent(p)
      .then(r => { setContent(r.content); setFileSize(r.size); })
      .catch(e => setContent(`（读取失败：${e}）`));
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
              ? <>
                  <span className="path"><b>{selected}</b></span>
                  {fileSize != null && (
                    <span style={{ color: 'var(--text-2)' }}>UTF-8 · {(fileSize / 1024).toFixed(1)} KB</span>
                  )}
                  <span className="spacer"></span>
                  <span className="chip" title="把文件路径带入会话输入框"
                    onClick={() => onInject(`@${selected} `)}>📌 在会话中引用</span>
                  <span className="chip" title="让 Agent 修改这个文件"
                    onClick={() => onInject(`请修改 ${selected}：`)}>✏️ 让 Agent 修改</span>
                </>
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
