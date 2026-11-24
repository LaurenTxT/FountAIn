import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { File as FileIcon, FileText, FolderOpen, LoaderCircle, Plus, X } from 'lucide-react';
import type { Attachment } from '../shared/types';
import { ATTACHMENTS_MAX, sizeText } from '../shared/attachments';
import type { Invoke } from './ui';

/** Attached images are served from FountAIn's own store by id and stored name. */
export const attachmentUrl = (item: Pick<Attachment, 'id' | 'name'>) => `fountain-asset://local/attachments/${item.id}/${encodeURIComponent(item.name)}`;

function fallbackFileName(file: File, index: number): string {
  if (file.name && file.name.trim()) return file.name.trim();
  const ext = file.type?.startsWith('image/') ? file.type.slice(6).replace('jpeg', 'jpg') : 'bin';
  return `pasted-${Date.now()}-${index + 1}.${ext}`;
}

/** Files waiting to go with the next message: picked with "+", pasted, or dropped onto the room. */
export function useAttachments(invoke: Invoke, initial: Attachment[] = [],controlled?:{items:Attachment[];update:(change:(previous:Attachment[])=>Attachment[])=>void}) {
  const [localItems, setLocalItems] = useState<Attachment[]>(initial), [busy, setBusy] = useState(false), [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const items=controlled?.items??localItems,setItems=controlled?.update??setLocalItems;
  const add = (added: Attachment[] | undefined) => { if (added?.length) setItems(previous => [...previous, ...added.filter(item => !previous.some(old => old.id === item.id))].slice(0, ATTACHMENTS_MAX)); };
  async function pick() { setBusy(true); try { add(await invoke<Attachment[]>('attachment.pick')); } catch {} finally { setBusy(false); } }
  async function importFiles(files: File[]) {
    if (!files.length) return;
    const paths: string[] = [];
    const memoryFiles: File[] = [];
    for (const file of files) {
      const p = window.fountain?.pathForFile?.(file) ?? '';
      if (p) paths.push(p);
      else memoryFiles.push(file);
    }
    setBusy(true);
    try {
      if (paths.length) add(await invoke<Attachment[]>('attachment.import', { paths }));
      if (memoryFiles.length) {
        const payload = await Promise.all(memoryFiles.slice(0, 12).map(async (file, index) => ({
          name: fallbackFileName(file, index),
          bytes: new Uint8Array(await file.arrayBuffer()),
        })));
        add(await invoke<Attachment[]>('attachment.importData', { files: payload }));
      }
    } catch {} finally { setBusy(false); }
  }
  async function drop(event: DragEvent) {
    dragDepth.current = 0;
    setDragging(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    await importFiles(files);
  }
  function onPaste(event: ClipboardEvent) {
    const dt = event.clipboardData;
    if (!dt) return;
    const fromFiles = [...(dt.files ?? [])];
    const fromItems = [...(dt.items ?? [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((f): f is File => Boolean(f));
    const files = fromFiles.length ? fromFiles : fromItems;
    if (!files.length) return;
    event.preventDefault();
    void importFiles(files);
  }
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const dropTarget = {
    onDragEnter: (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } },
    onDragOver: (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); } },
    onDragLeave: (event: DragEvent) => { if (hasFiles(event)) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); } },
    onDrop: (event: DragEvent) => void drop(event),
  };
  return { items, busy, dragging, pick, dropTarget, onPaste, remove: (id: string) => setItems(previous => previous.filter(item => item.id !== id)), clear: () => setItems(() => []) };
}

export function AttachButton({ onPick, busy, disabled, title = '添加图片或文件（也可以直接拖进来）' }: { onPick: () => void; busy: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className="icon-button attach-button" aria-label="添加图片或文件" title={title} disabled={busy || disabled} onClick={onPick}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={17} />}</button>;
}

const kindIcon = (item: Attachment) => item.kind === 'text' ? <FileText size={16} /> : <FileIcon size={16} />;

/** The files about to be sent, each removable. */
export function AttachmentTray({ items, onRemove }: { items: Attachment[]; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  return <div className="attachment-tray" aria-label="待发送的附件">{items.map(item => <span className="attachment-chip" key={item.id}>
    {item.kind === 'image' ? <img src={attachmentUrl(item)} alt="" /> : <span className="attachment-icon">{kindIcon(item)}</span>}
    <span className="attachment-meta"><strong title={item.name}>{item.name}</strong><small>{sizeText(item.size)}</small></span>
    <button type="button" aria-label={`移除附件 ${item.name}`} onClick={() => onRemove(item.id)}><X size={12} /></button>
  </span>)}</div>;
}

/** Files on a sent message: pictures open an enlarged lightbox preview; other files reveal in Explorer. */
export function AttachmentList({ items, invoke, align = 'start' }: { items?: Attachment[]; invoke: Invoke; align?: 'start' | 'end' }) {
  const [preview, setPreview] = useState<Attachment | null>(null);
  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);
  if (!items?.length) return null;
  const reveal = (item: Attachment) => void invoke('attachment.reveal', { id: item.id, name: item.name }).catch(() => {});
  return <>
    <div className={`attachment-list ${align}`}>{items.map(item => item.kind === 'image'
      ? <button type="button" key={item.id} className="attachment-image" title={`${item.name} · 点击或双击放大查看`} onClick={() => setPreview(item)} onDoubleClick={() => setPreview(item)}><img src={attachmentUrl(item)} alt={item.name} /></button>
      : <span key={item.id} className="attachment-chip sent"><span className="attachment-icon">{kindIcon(item)}</span><span className="attachment-meta"><strong title={item.name}>{item.name}</strong><small>{sizeText(item.size)}</small></span>
        <button type="button" aria-label={`在文件夹中显示 ${item.name}`} title="在文件夹中显示" onClick={() => reveal(item)}><FolderOpen size={13} /></button></span>)}</div>
    {preview && createPortal(
      <div className="image-lightbox" role="dialog" aria-label={`查看大图 ${preview.name}`} onClick={() => setPreview(null)}>
        <div className="image-lightbox-inner" onClick={event => event.stopPropagation()}>
          <img src={attachmentUrl(preview)} alt={preview.name} />
          <div className="image-lightbox-bar">
            <span title={preview.name}>{preview.name}</span>
            <button type="button" className="button small secondary" onClick={() => reveal(preview)}><FolderOpen size={13} />在文件夹中显示</button>
            <button type="button" className="button small quiet" onClick={() => setPreview(null)}><X size={14} />关闭</button>
          </div>
        </div>
      </div>,
      document.body,
    )}
  </>;
}
