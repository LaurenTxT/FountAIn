import { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { Markdown } from './Markdown';
import type { Invoke } from './ui';

export type DocumentSelection = { projectId: string; target: string };
type Preview = { relativePath: string; document?: { content: string; language: string; truncated: boolean } };

export function ProjectDocument({ selection, invoke, onClose }: {
  selection: DocumentSelection; invoke: Invoke; onClose: () => void;
}) {
  const [result, setResult] = useState<{ selection: DocumentSelection; preview?: Preview; error?: string }>();
  const [actionError, setActionError] = useState('');
  const current = result?.selection === selection ? result : undefined;
  const preview = current?.preview;

  useEffect(() => {
    let active = true;
    setActionError('');
    void invoke<Preview>('project.document.read', selection).then(
      value => { if (active) setResult({ selection, preview: value }); },
      error => { if (active) setResult({ selection, error: (error as Error).message }); },
    );
    return () => { active = false; };
  }, [invoke, selection]);

  function open(mode: 'open' | 'reveal') {
    if (!preview) return;
    setActionError('');
    void invoke('project.openPath', { projectId: selection.projectId, relativePath: preview.relativePath, mode })
      .catch(error => setActionError((error as Error).message));
  }

  const title = selection.target.split(/[/\\]/).pop();
  return <aside className="project-document" aria-label="项目文件预览">
    <header>
      <strong title={title}>{title}</strong>
      <button type="button" className="icon-button" title="关闭文件预览" aria-label="关闭文件预览" onClick={onClose}><X size={16}/></button>
    </header>
    {preview && <div className="project-document-actions">
      <button type="button" className="button small secondary" onClick={() => open('reveal')}><FolderOpen size={15}/>打开所在文件夹</button>
      <button type="button" className="button small quiet" onClick={() => open('open')}>用系统应用打开</button>
    </div>}
    <div className="project-document-body">
      {actionError && <p role="alert">{actionError}</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {!current && <p role="status">正在读取文件…</p>}
      {preview && (preview.document ? <>
        {preview.document.truncated && <p>文件较长，仅预览开头。可用系统应用查看全文。</p>}
        {preview.document.language === 'markdown' ? <Markdown text={preview.document.content}/> : <pre>{preview.document.content}</pre>}
      </> : <p>这种文件可用系统应用查看。</p>)}
    </div>
  </aside>;
}
