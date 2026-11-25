import { useEffect, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import { Markdown } from './Markdown';
import { projectFileLink } from '../shared/round-results';
import type { Invoke } from './ui';

export type DocumentSelection = { projectId: string; target: string };
type Preview = { relativePath: string; openable: boolean; directory: boolean; document?: { content: string; language: string; truncated: boolean } };

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

  const title = (projectFileLink(selection.target) ?? selection.target).split(/[/\\]/).filter(Boolean).pop();
  const extension = preview?.relativePath.split('.').pop()?.toLowerCase();
  return <aside className="project-document" aria-label="项目文件预览">
    <header>
      <strong title={title}>{title}</strong>
      <button type="button" className="icon-button" title="关闭文件预览" aria-label="关闭文件预览" onClick={onClose}><X size={16}/></button>
    </header>
    {preview && <div className="project-document-actions">
      <button type="button" className="button small secondary" onClick={() => open('reveal')}><FolderOpen size={15}/>{preview.directory ? '打开文件夹' : '打开所在文件夹'}</button>
      {preview.openable && <button type="button" className="button small quiet" onClick={() => open('open')}>{extension === 'mp4' ? '用系统播放器打开' : extension === 'zip' ? '打开压缩包' : '用系统应用打开'}</button>}
    </div>}
    <div className="project-document-body">
      {actionError && <p role="alert">{actionError}</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {!current && <p role="status">正在读取文件…</p>}
      {preview && (preview.document ? <>
        {preview.document.truncated && <p>文件较长，仅预览开头。可用系统应用查看全文。</p>}
        {preview.document.language === 'markdown' ? <Markdown text={preview.document.content}/> : <pre>{preview.document.content}</pre>}
      </> : preview.openable ? <p>可用系统应用查看此文件。</p> : null)}
    </div>
  </aside>;
}
