import { useEffect, useState } from 'react';
import { Check, FolderOpen, LoaderCircle, Pencil, Save, X } from 'lucide-react';
import { Markdown } from './Markdown';
import { projectFileLink } from '../shared/round-results';
import type { Invoke } from './ui';

export type DocumentSelection = { projectId: string; target: string; edit?: boolean };
type Preview = { relativePath: string; openable: boolean; directory: boolean; document?: { content: string; language: string; truncated: boolean } };

export function ProjectDocument({ selection, invoke, onClose }: {
  selection: DocumentSelection; invoke: Invoke; onClose: () => void;
}) {
  const [result, setResult] = useState<{ selection: DocumentSelection; preview?: Preview; error?: string }>();
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState(Boolean(selection.edit));
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const current = result?.selection === selection ? result : undefined;
  const preview = current?.preview;
  const original = preview?.document?.content ?? '';
  const dirty = editing && draft !== original;

  useEffect(() => {
    let active = true;
    setActionError('');
    setEditing(Boolean(selection.edit));
    setSavedFlash(false);
    void invoke<Preview>('project.document.read', { projectId: selection.projectId, target: selection.target }).then(
      value => {
        if (!active) return;
        setResult({ selection, preview: value });
        setDraft(value.document?.content ?? '');
      },
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

  async function save() {
    if (!preview || saving) return;
    setSaving(true);
    setActionError('');
    try {
      await invoke('project.file.write', {
        projectId: selection.projectId,
        relativePath: preview.relativePath,
        content: draft,
      }, `已保存 ${preview.relativePath}`);
      setResult(prev => prev?.preview ? {
        ...prev,
        preview: {
          ...prev.preview,
          document: {
            content: draft,
            language: prev.preview.document?.language ?? 'text',
            truncated: false,
          },
        },
      } : prev);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1600);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function startEdit() {
    if (!preview?.document) return;
    setDraft(preview.document.content);
    setEditing(true);
  }

  function cancelEdit() {
    if (dirty && !window.confirm('放弃未保存的修改？')) return;
    setDraft(original);
    setEditing(false);
  }

  const title = (projectFileLink(selection.target) ?? selection.target).split(/[/\\]/).filter(Boolean).pop();
  const extension = preview?.relativePath.split('.').pop()?.toLowerCase();
  const canEdit = Boolean(preview && !preview.directory && preview.document && !preview.document.truncated);

  return <aside className="project-document" aria-label="项目文件预览与编辑">
    <header>
      <strong title={preview?.relativePath ?? title}>
        {title}
        {dirty && <span className="doc-dirty-dot" title="有未保存的修改">●</span>}
      </strong>
      <div className="doc-head-actions">
        {canEdit && !editing && (
          <button type="button" className="button small secondary" onClick={startEdit} title="在右侧直接编辑文件">
            <Pencil size={13} />编辑
          </button>
        )}
        {editing && (
          <>
            <button type="button" className="button small primary" disabled={saving || !dirty} onClick={() => void save()} title="保存修改 (Ctrl+S)">
              {saving ? <LoaderCircle size={13} className="spin" /> : savedFlash ? <Check size={13} /> : <Save size={13} />}
              {savedFlash ? '已保存' : '保存'}
            </button>
            <button type="button" className="button small quiet" disabled={saving} onClick={cancelEdit}>完成</button>
          </>
        )}
        <button type="button" className="icon-button" title="关闭文件" aria-label="关闭文件" onClick={() => { if (dirty && !window.confirm('文件尚未保存，确定关闭？')) return; onClose(); }}><X size={16}/></button>
      </div>
    </header>
    {preview && <div className="project-document-actions">
      <span className="doc-rel-path" title={preview.relativePath}>{preview.relativePath}</span>
      <button type="button" className="button small quiet" onClick={() => open('reveal')}><FolderOpen size={14}/>打开位置</button>
      {preview.openable && <button type="button" className="button small quiet" onClick={() => open('open')}>{extension === 'mp4' ? '播放器打开' : extension === 'zip' ? '打开压缩包' : '外部打开'}</button>}
    </div>}
    <div className={`project-document-body ${editing ? 'is-editing' : ''}`}>
      {actionError && <p role="alert">{actionError}</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {!current && <p role="status">正在读取文件…</p>}
      {preview && (editing ? (
        <textarea
          className="doc-editor-textarea"
          value={draft}
          spellCheck={false}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              void save();
            } else if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const next = draft.slice(0, start) + '  ' + draft.slice(end);
              setDraft(next);
              window.requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
            }
          }}
        />
      ) : preview.document ? <>
        {preview.document.truncated && <p className="doc-truncated-note">文件较长，仅预览开头（暂不支持在线编辑）。可用外部应用查看全文。</p>}
        {preview.document.language === 'markdown' ? <Markdown text={preview.document.content}/> : <pre>{preview.document.content}</pre>}
      </> : preview.openable ? <p>可用系统应用查看此文件。</p> : null)}
    </div>
  </aside>;
}
