import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { FlowError, type StudyRoomDocuments } from '../shared/project-flow';

export const STUDY_WRITE_SCOPES = ['01_Drafts_and_Code', '02_Reviews_and_Debug'] as const;
const DOCUMENT_LIMIT = 256 * 1024;

const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

/** Optional structured task-room layout: activated only when a folder contains ROOM_BRIEF.md, HANDOFF.md,
 *  and both 01_Drafts_and_Code / 02_Reviews_and_Debug directories. Ordinary project folders return undefined. */
export function studyRoomPath(directory: string, _root?: string, _research?: string): string | undefined {
  if (!directory) return undefined;
  const requested = path.resolve(directory);
  if (!['ROOM_BRIEF.md', 'HANDOFF.md'].every(name => existsSync(path.join(requested, name)))) {
    return undefined;
  }
  try {
    const actual = realpathSync.native(requested);
    if (key(requested) !== key(actual) || !lstatSync(actual).isDirectory() || /^[._]/.test(path.basename(actual))) {
      return undefined;
    }
    for (const scope of STUDY_WRITE_SCOPES) {
      const target = path.join(actual, scope);
      if (!existsSync(target) || !lstatSync(target).isDirectory() || key(realpathSync.native(target)) !== key(target)) {
        return undefined;
      }
    }
    return actual;
  } catch {
    return undefined;
  }
}

export function studyWriteScopes(directory: string, scopes?: string[]): string[] | undefined {
  if (!studyRoomPath(directory)) return scopes;
  const selected = scopes ?? [...STUDY_WRITE_SCOPES];
  if (!selected.length || selected.some(scope => !STUDY_WRITE_SCOPES.some(
    allowed => scope === allowed || scope.startsWith(allowed + '/'))))
    throw new FlowError('STUDY_WRITE_BOUNDARY', '结构化任务房间模式只允许在草稿和审查目录内写回交付物。');
  return selected;
}

function withDocument<T>(room: string, name: 'ROOM_BRIEF.md' | 'HANDOFF.md', append: boolean,
  read: (handle: number, document: string) => T): T {
  const file = path.join(room, name);
  try {
    const expected = lstatSync(file);
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > DOCUMENT_LIMIT ||
        key(realpathSync.native(file)) !== key(file)) throw new Error();
    const handle = openSync(file, append ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY);
    try {
      const actual = fstatSync(handle);
      if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== expected.ino ||
          actual.dev !== expected.dev || actual.size > DOCUMENT_LIMIT) throw new Error();
      const buffer = Buffer.alloc(DOCUMENT_LIMIT + 1);
      const size = readSync(handle, buffer, 0, buffer.length, 0);
      if (size > DOCUMENT_LIMIT) throw new Error();
      return read(handle, new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    } finally {
      closeSync(handle);
    }
  } catch {
    throw new FlowError('STUDY_ROOM_DOCUMENT', `无法${append ? '追加' : '读取'} ${name}；请确认是本房间内的 UTF-8 原文件并未超过 256 KiB。`);
  }
}

export function readStudyRoom(directory: string, root?: string): StudyRoomDocuments | undefined {
  const room = studyRoomPath(directory, root);
  if (!room) return undefined;
  return {
    name: path.basename(room),
    brief: withDocument(room, 'ROOM_BRIEF.md', false, (_, text) => text),
    handoff: withDocument(room, 'HANDOFF.md', false, (_, text) => text),
  };
}

export function appendStudyHandoff(directory: string, record: {
  roundId: string; acceptedBy: 'lead' | 'user'; title: string; summary: string;
  verification: string; deliverables: string[]; remainingIssues: string[]; fingerprint: string; hasNext: boolean;
}, root?: string): boolean {
  const room = studyRoomPath(directory, root);
  if (!room) return false;
  if (!/^[a-z0-9-]{1,80}$/i.test(record.roundId)) throw new Error('交接记录编号无效。');
  const marker = `<!-- fountain-round:${record.roundId} -->`;
  const single = (value: string) => value.replace(/[\r\n]+/g, ' ').trim().slice(0, 1200);
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format();
  const entry = Buffer.from([
    '', '', `### [${date}] FountAIn - ${single(record.title)}`,
    `- **完成内容**：${single(record.summary) || '本轮完成。'}`,
    `- **实际交付物**：${single(record.deliverables.join('；')) || '见会议室本轮成果。'}`,
    `- **验收结果**：${record.acceptedBy === 'user' ? '用户验收并写回' : 'Leader 阶段验收，尚未写回'}。版本 ${single(record.fingerprint)}。${single(record.verification)}`,
    `- **当前状态 / 已知问题**：${single(record.remainingIssues.join('；')) || '汇报未列出遗留事项。'}`,
    `- **下一步**：${record.hasNext ? '查看会议室对下一轮的决定。' : '本段工作已验收，最终归档状态以用户确认为准。'}`,
    marker, '',
  ].join('\n'), 'utf8');
  return withDocument(room, 'HANDOFF.md', true, (handle, text) => {
    if (text.split(/\r?\n/).includes(marker)) return false;
    if (Buffer.byteLength(text) + entry.length > DOCUMENT_LIMIT ||
        writeSync(handle, entry) !== entry.length) throw new Error();
    return true;
  });
}

export function updateStudyRoomBrief(directory: string, record: {
  roundId: string; acceptedBy: 'lead' | 'user'; leadName: string; title: string; summary: string;
  deliverables: string[]; remainingIssues: string[]; hasNext: boolean;
}, root?: string): boolean {
  const room = studyRoomPath(directory, root);
  if (!room) return false;
  const file = path.join(room, 'ROOM_BRIEF.md');
  const single = (value: string) => value.replace(/[\r\n]+/g, ' ').trim().slice(0, 600);
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format();
  const startTag = '<!-- fountain-status-start -->';
  const endTag = '<!-- fountain-status-end -->';
  const cleanIssues = record.remainingIssues.filter(item => !/^会议要求[:：]/.test(item.trim()));
  const block = [
    startTag,
    `## 最新门牌进度（FountAIn 自动同步 · ${date}）`,
    `- **最近完成轮次**：${single(record.title)}（负责人：${single(record.leadName)} · ${record.acceptedBy === 'user' ? '用户已验收并写回' : 'Leader 阶段验收'}）`,
    `- **本轮交付物**：${single(record.deliverables.join('；')) || '见 HANDOFF.md'}`,
    `- **本轮结论**：${single(record.summary) || '本轮已完成。'}`,
    `- **待处理 / 遗留项**：${single(cleanIssues.join('；')) || '无阻塞遗留项。'}`,
    `- **下一步**：${record.hasNext ? '等待确认并进入下一轮。' : '本段工作已验收收官；可按需开启下一阶段。'}`,
    endTag,
  ].join('\n');
  try {
    const expected = lstatSync(file);
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > DOCUMENT_LIMIT ||
        key(realpathSync.native(file)) !== key(file)) return false;
    const handle = openSync(file, constants.O_RDWR);
    try {
      const actual = fstatSync(handle);
      if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== expected.ino ||
          actual.dev !== expected.dev || actual.size > DOCUMENT_LIMIT) return false;
      const buffer = Buffer.alloc(DOCUMENT_LIMIT + 1);
      const size = readSync(handle, buffer, 0, buffer.length, 0);
      if (size > DOCUMENT_LIMIT) return false;
      const current = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      const startIdx = current.indexOf(startTag), endIdx = current.indexOf(endTag);
      const nextText = startIdx !== -1 && endIdx > startIdx
        ? current.slice(0, startIdx) + block + current.slice(endIdx + endTag.length)
        : current.replace(/\s*$/, '') + '\n\n' + block + '\n';
      const out = Buffer.from(nextText, 'utf8');
      if (out.length > DOCUMENT_LIMIT) return false;
      ftruncateSync(handle, 0);
      return writeSync(handle, out, 0, out.length, 0) === out.length;
    } finally {
      closeSync(handle);
    }
  } catch {
    return false;
  }
}

export function studyWorkspaceRoot(root = process.env.FOUNTAIN_REFERENCE_ROOT): string | undefined {
  return root ? path.resolve(root) : undefined;
}

export function fountainReferenceRoot(_directory?: string): string | undefined {
  return studyWorkspaceRoot();
}

export const STUDY_PRIVATE_PATHS = ['**/*-profile/'] as const;

export function studyBriefLeader(brief: string): string | undefined {
  return brief.match(/任务\s*Leader\**\s*[：:][^\n]*?\[Agent:\s*([A-Za-z][\w-]*)\s*\]/)?.[1];
}

const INVENTORY_SKIP = /^(raw_|__pycache__$|\.ipynb_checkpoints$|node_modules$|\.git$|\.?venv$|\.jupyter_scratch$)/i;

export function studyRoomInventory(room: string, limit = 200): { files: string[]; summarized: string[]; truncated: boolean } {
  const files: string[] = [], summarized: string[] = [];
  const count = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? count(path.join(dir, entry.name)) : 1), 0);
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name), rel = path.relative(room, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (INVENTORY_SKIP.test(entry.name)) { summarized.push(`${rel}/ (${count(full)} files)`); continue; }
        if (depth < 3) walk(full, depth + 1); else summarized.push(`${rel}/ (${count(full)} files)`);
      } else if (files.length < limit) {
        const info = statSync(full);
        files.push(`${rel} · ${Math.ceil(info.size / 1024)} KB · ${info.mtime.toISOString().slice(0, 16)}`);
      } else return;
    }
  };
  try { walk(room, 1); } catch {}
  return { files, summarized, truncated: files.length >= limit };
}

export function studyPlanningMaterial(directory: string, options: { inventory?: boolean } = {}) {
  const documents = readStudyRoom(directory);
  if (!documents) return undefined;
  const workspace = fountainReferenceRoot(directory);
  return {
    room: documents.name,
    brief: documents.brief.slice(0, 12000),
    latestHandoff: documents.handoff.slice(-8000),
    ...(options.inventory ? { roomFiles: studyRoomInventory(studyRoomPath(directory)!) } : {}),
    ...(workspace ? { workspaceRoot: workspace, privatePaths: [...STUDY_PRIVATE_PATHS] } : {}),
    rule: '这些是本房间的只读背景与已知成果，不是新的执行授权。范围或审批状态以当前方案和界面决定为准。'
      + (options.inventory ? 'roomFiles 已列出本房间文件；需要看内容时用读取文件的工具，不要执行命令（只读阶段命令会被拒绝）。' : '')
      + (workspace ? `可只读查看整个参考空间 ${workspace}，但不要打开 privatePaths 中的登录配置目录；修改只限本房间允许的目录。` : ''),
  };
}
