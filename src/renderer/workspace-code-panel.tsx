import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileCode2,
  FileDiff,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  History,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { Project, RoomId } from '../shared/types';
import {
  formatDiffAnnotationsPrompt,
  type DiffAnnotation,
  type GitChangedFile,
  type ProjectCheckpointItem,
  type ProjectGitDiffResult,
  type ProjectGitStatus,
  type ProjectScriptItem,
  type ProjectScriptRunResult,
  type ProjectTreeEntry,
} from '../shared/workspace-tools';
import { Avatar, useTeam } from './members';
import { Modal } from './modals';
import { shortDateTime, type Invoke } from './ui';

type CodeSubTab = 'changes' | 'files' | 'checkpoints';

interface ParsedDiffLine {
  kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
}

function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  const out: ParsedDiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('@@ ')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNum = Number(m[1]);
        newNum = Number(m[2]);
      }
      out.push({ kind: 'hunk', text: line });
    } else if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode')
    ) {
      out.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), newLine: newNum++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldLine: oldNum++ });
    } else {
      out.push({
        kind: 'ctx',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldLine: oldNum > 0 ? oldNum++ : undefined,
        newLine: newNum > 0 ? newNum++ : undefined,
      });
    }
  }
  return out;
}

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'css', 'html', 'sh'].includes(ext)) {
    return <FileCode2 size={14} className="wt-file-ico code" />;
  }
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) {
    return <FileJson size={14} className="wt-file-ico json" />;
  }
  if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'].includes(ext)) {
    return <ImageIcon size={14} className="wt-file-ico img" />;
  }
  return <FileText size={14} className="wt-file-ico text" />;
}

export function WorkspaceCodePanel({
  project,
  roomId,
  roster,
  invoke,
  scriptsOpen,
  onToggleScripts,
  onOpenDocument,
  onSentToRoom,
  checkpointTrigger,
}: {
  project: Project;
  roomId: RoomId;
  roster: string[];
  invoke: Invoke;
  scriptsOpen: boolean;
  onToggleScripts: (open?: boolean) => void;
  onOpenDocument: (relativePath: string) => void;
  onSentToRoom?: () => void;
  checkpointTrigger?: number;
}) {
  const team = useTeam();
  const [subTab, setSubTab] = useState<CodeSubTab>('changes');
  const [gitStatus, setGitStatus] = useState<ProjectGitStatus | null>(null);
  const [loadingGit, setLoadingGit] = useState(false);
  const [error, setError] = useState('');

  // Commit & branch controls
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [initializingGit, setInitializingGit] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  // Orca Annotated Diff state
  const [diffModal, setDiffModal] = useState<{
    title: string;
    path: string;
    diff: string;
    isBinary?: boolean;
  } | null>(null);
  const [annotations, setAnnotations] = useState<DiffAnnotation[]>([]);
  const [draftLine, setDraftLine] = useState<{ line: number; side: 'new' | 'old'; codeLine: string } | null>(null);
  const [draftText, setDraftText] = useState('');
  const [annotationTarget, setAnnotationTarget] = useState<string>('');
  const [sendingAnnotations, setSendingAnnotations] = useState(false);

  // File tree state
  const [treeMap, setTreeMap] = useState<Record<string, ProjectTreeEntry[]>>({});
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(['']));
  const [loadingDir, setLoadingDir] = useState<string | null>(null);

  // Checkpoints state
  const [checkpoints, setCheckpoints] = useState<ProjectCheckpointItem[]>([]);
  const [cpLabel, setCpLabel] = useState('');
  const [cpBusy, setCpBusy] = useState(false);

  // Script runner state
  const [scripts, setScripts] = useState<ProjectScriptItem[]>([]);
  const [customCmd, setCustomCmd] = useState('');
  const [runningCmd, setRunningCmd] = useState('');
  const [lastRun, setLastRun] = useState<ProjectScriptRunResult | null>(null);
  const [sendingError, setSendingError] = useState(false);

  const loadGit = useCallback(async () => {
    setLoadingGit(true);
    try {
      const res = await invoke<ProjectGitStatus>('project.git.status', { projectId: project.id });
      setGitStatus(res);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingGit(false);
    }
  }, [invoke, project.id]);

  const loadDir = useCallback(
    async (dir: string) => {
      setLoadingDir(dir);
      try {
        const entries = await invoke<ProjectTreeEntry[]>('project.tree', { projectId: project.id, dir });
        setTreeMap((prev) => ({ ...prev, [dir]: entries }));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingDir(null);
      }
    },
    [invoke, project.id],
  );

  const loadCheckpoints = useCallback(async () => {
    try {
      const list = await invoke<ProjectCheckpointItem[]>('project.checkpoints.list', { projectId: project.id });
      setCheckpoints(list);
    } catch {
      setCheckpoints([]);
    }
  }, [invoke, project.id]);

  const loadScripts = useCallback(async () => {
    try {
      const list = await invoke<ProjectScriptItem[]>('project.scripts.list', { projectId: project.id });
      setScripts(list);
    } catch {
      setScripts([]);
    }
  }, [invoke, project.id]);

  useEffect(() => {
    setTreeMap({});
    setOpenDirs(new Set(['']));
    setAnnotations([]);
    setLastRun(null);
    void loadGit();
    void loadScripts();
    void loadCheckpoints();
  }, [project.id, loadGit, loadScripts, loadCheckpoints]);

  useEffect(() => {
    if (subTab === 'files' && !treeMap['']) {
      void loadDir('');
    } else if (subTab === 'checkpoints') {
      void loadCheckpoints();
    }
  }, [subTab, treeMap, loadDir, loadCheckpoints]);

  useEffect(() => {
    if (!checkpointTrigger) return;
    void (async () => {
      setCpBusy(true);
      try {
        await invoke('project.checkpoints.create', { projectId: project.id, label: '快捷安全快照' }, '已创建安全检查点。');
        await loadCheckpoints();
        setSubTab('checkpoints');
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setCpBusy(false);
      }
    })();
  }, [checkpointTrigger, invoke, project.id, loadCheckpoints]);

  async function openFileDiff(file: GitChangedFile) {
    try {
      const res = await invoke<ProjectGitDiffResult>('project.git.diff', {
        projectId: project.id,
        relativePath: file.path,
      });
      setDraftLine(null);
      setDraftText('');
      setDiffModal({
        title: file.path,
        path: file.path,
        diff: res.diff,
        isBinary: res.isBinary,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleInitGit() {
    if (initializingGit) return;
    setInitializingGit(true);
    try {
      await invoke(
        'project.git.init',
        { projectId: project.id },
        '已初始化本地 Git 存档仓库并打好基线快照，现在可以使用 Diff、批注和检查点回滚了！',
      );
      await Promise.all([loadGit(), loadScripts(), loadCheckpoints()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setInitializingGit(false);
    }
  }

  async function handleCommit() {
    if (!commitMsg.trim() || committing) return;
    setCommitting(true);
    try {
      await invoke('project.git.commit', { projectId: project.id, message: commitMsg.trim() }, '已提交到本地 Git。');
      setCommitMsg('');
      await loadGit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  async function handleRevertFile(file: GitChangedFile) {
    const msg =
      file.code === '?'
        ? `删除未跟踪的新文件「${file.path}」？此操作不可撤销。`
        : `撤销「${file.path}」的未提交修改？`;
    if (!window.confirm(msg)) return;
    try {
      await invoke(
        'project.git.revertFile',
        { projectId: project.id, relativePath: file.path, untracked: file.code === '?' },
        `已恢复 ${file.path}`,
      );
      await loadGit();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleCheckout(branch: string, create = false) {
    if (!branch.trim()) return;
    try {
      await invoke(
        'project.git.checkout',
        { projectId: project.id, branch: branch.trim(), create },
        create ? `已创建并切换到 ${branch.trim()}` : `已切换到分支 ${branch.trim()}`,
      );
      setBranchMenuOpen(false);
      setNewBranchName('');
      await loadGit();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function addAnnotation() {
    if (!diffModal || !draftLine || !draftText.trim()) return;
    setAnnotations((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        path: diffModal.path,
        line: draftLine.line,
        side: draftLine.side,
        codeLine: draftLine.codeLine,
        comment: draftText.trim(),
      },
    ]);
    setDraftLine(null);
    setDraftText('');
  }

  async function sendAnnotationsToRoom() {
    if (!annotations.length || sendingAnnotations) return;
    setSendingAnnotations(true);
    try {
      const targetName = annotationTarget ? team.get(annotationTarget)?.name : undefined;
      const text = formatDiffAnnotationsPrompt(annotations, targetName);
      await invoke(
        'room.send',
        {
          roomId,
          text,
          memberIds: roster,
          mode: 'discuss',
          style: 'chat',
          maxMinutes: 0,
          handRaise: false,
          hostPick: false,
        },
        `已发送 ${annotations.length} 条行级批注给成员。`,
      );
      setAnnotations([]);
      setDiffModal(null);
      onSentToRoom?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSendingAnnotations(false);
    }
  }

  async function runCommand(cmd: string) {
    if (!cmd.trim() || runningCmd) return;
    setRunningCmd(cmd.trim());
    try {
      const res = await invoke<ProjectScriptRunResult>('project.scripts.run', {
        projectId: project.id,
        command: cmd.trim(),
      });
      setLastRun(res);
    } catch (err) {
      setLastRun({
        command: cmd.trim(),
        exitCode: 1,
        ok: false,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: 0,
      });
    } finally {
      setRunningCmd('');
    }
  }

  async function sendScriptErrorToAgent() {
    if (!lastRun || sendingError) return;
    setSendingError(true);
    try {
      const logTail = [lastRun.stderr, lastRun.stdout]
        .filter(Boolean)
        .join('\n')
        .trim()
        .slice(-2800);
      const codex = team.members.find((m) => m.id === 'codex' && roster.includes(m.id));
      const mention = codex ? `@${codex.name} ` : '';
      const text = `${mention}项目运行命令 \`${lastRun.command}\` 失败（退出码 ${lastRun.exitCode}），请帮我定位根因并修复：\n\n\`\`\`\n${logTail || '（无输出）'}\n\`\`\``;
      await invoke(
        'room.send',
        {
          roomId,
          text,
          memberIds: roster,
          mode: 'discuss',
          style: 'chat',
          maxMinutes: 0,
          handRaise: false,
          hostPick: false,
        },
        '已把报错日志发到会议室。',
      );
      onSentToRoom?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSendingError(false);
    }
  }

  async function createCheckpointNow() {
    if (cpBusy) return;
    setCpBusy(true);
    try {
      await invoke(
        'project.checkpoints.create',
        { projectId: project.id, label: cpLabel.trim() || '手动安全快照' },
        '已保存检查点。',
      );
      setCpLabel('');
      await loadCheckpoints();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCpBusy(false);
    }
  }

  async function previewCheckpointDiff(cp: ProjectCheckpointItem) {
    try {
      const res = await invoke<{ diff: string }>('project.checkpoints.diff', {
        projectId: project.id,
        checkpointId: cp.id,
      });
      setDiffModal({
        title: `与检查点「${cp.label}」的差异`,
        path: cp.id,
        diff: res.diff || '（当前工作区与该检查点完全一致）',
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function restoreCheckpointNow(cp: ProjectCheckpointItem) {
    if (!window.confirm(`确定回滚工作区到检查点「${cp.label}」？回滚前会自动保存一份当前备份。`)) return;
    setCpBusy(true);
    try {
      await invoke(
        'project.checkpoints.restore',
        { projectId: project.id, checkpointId: cp.id },
        `已恢复到「${cp.label}」，原状态已自动备份。`,
      );
      await Promise.all([loadGit(), loadCheckpoints()]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCpBusy(false);
    }
  }

  async function toggleDir(relPath: string) {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
    if (!treeMap[relPath]) {
      await loadDir(relPath);
    }
  }

  async function mentionFileInRoom(relPath: string) {
    try {
      await navigator.clipboard?.writeText(`@${relPath}`);
    } catch {
      // Clipboard may be unavailable
    }
    onOpenDocument(relPath);
  }

  const parsedDiffLines = useMemo(() => (diffModal ? parseUnifiedDiff(diffModal.diff) : []), [diffModal]);
  const rosterMembers = useMemo(
    () => team.members.filter((m) => roster.includes(m.id)),
    [team.members, roster],
  );

  function renderTree(dir: string, depth: number) {
    const list = treeMap[dir] ?? [];
    return list.map((entry) => {
      const isOpen = openDirs.has(entry.path);
      return (
        <div key={entry.path}>
          <div className="wt-tree-row" style={{ paddingLeft: `${10 + depth * 14}px` }}>
            {entry.isDir ? (
              <button
                type="button"
                className="wt-tree-main"
                onClick={() => void toggleDir(entry.path)}
              >
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {isOpen ? (
                  <FolderOpen size={14} className="wt-file-ico dir" />
                ) : (
                  <Folder size={14} className="wt-file-ico dir" />
                )}
                <span className="wt-tree-name">{entry.name}</span>
              </button>
            ) : (
              <button
                type="button"
                className="wt-tree-main"
                onClick={() => onOpenDocument(entry.path)}
                title={entry.path}
              >
                <span className="wt-tree-spacer" />
                {fileIcon(entry.name)}
                <span className="wt-tree-name">{entry.name}</span>
              </button>
            )}
            {!entry.isDir && (
              <button
                type="button"
                className="wt-tree-act"
                title={`复制 @${entry.path} 并预览`}
                onClick={() => void mentionFileInRoom(entry.path)}
              >
                @
              </button>
            )}
          </div>
          {entry.isDir && isOpen && (
            <div>
              {loadingDir === entry.path && !treeMap[entry.path] ? (
                <div className="wt-tree-loading" style={{ paddingLeft: `${26 + depth * 14}px` }}>
                  <LoaderCircle size={12} className="spin" /> 读取中…
                </div>
              ) : (
                renderTree(entry.path, depth + 1)
              )}
            </div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="wt-panel">
      {/* Top Git + Script Header */}
      <div className="wt-header">
        <div className="wt-branch-wrap">
          {gitStatus?.isRepo ? (
            <button
              type="button"
              className="wt-branch-pill"
              onClick={() => setBranchMenuOpen((v) => !v)}
              title={`当前分支 ${gitStatus.branch}${gitStatus.headShort ? ` (${gitStatus.headShort})` : ''} · 点击切换或新建`}
            >
              <GitBranch size={13} />
              <span>{gitStatus.branch}</span>
              {gitStatus.ahead > 0 && <em className="wt-ahead">↑{gitStatus.ahead}</em>}
              {gitStatus.behind > 0 && <em className="wt-behind">↓{gitStatus.behind}</em>}
              <ChevronDown size={12} />
            </button>
          ) : (
            <span className="wt-branch-pill muted">
              <Folder size={13} />
              <span>非 Git 目录</span>
            </span>
          )}
          {gitStatus?.isRepo && (gitStatus.totalAdded > 0 || gitStatus.totalDeleted > 0) && (
            <span className="wt-diff-stat">
              <em className="add">+{gitStatus.totalAdded}</em>
              <em className="del">-{gitStatus.totalDeleted}</em>
            </span>
          )}
        </div>
        <div className="wt-header-actions">
          <button
            type="button"
            className={`icon-button ${scriptsOpen ? 'active' : ''}`}
            title="脚本运行器 (Ctrl+J)"
            aria-label="脚本运行器"
            onClick={() => onToggleScripts()}
          >
            <Terminal size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="刷新代码与 Git 状态"
            aria-label="刷新"
            disabled={loadingGit}
            onClick={() => {
              void loadGit();
              if (subTab === 'files') void loadDir('');
              if (subTab === 'checkpoints') void loadCheckpoints();
            }}
          >
            <RefreshCw size={14} className={loadingGit ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* Branch switcher popover */}
      {branchMenuOpen && gitStatus?.isRepo && (
        <div className="wt-branch-menu">
          <div className="wt-branch-list">
            {gitStatus.branches.map((b) => (
              <button
                key={b}
                type="button"
                className={`wt-branch-item ${b === gitStatus.branch ? 'current' : ''}`}
                onClick={() => void handleCheckout(b, false)}
              >
                <GitBranch size={12} />
                <span>{b}</span>
                {b === gitStatus.branch && <Check size={12} />}
              </button>
            ))}
          </div>
          <div className="wt-branch-new">
            <input
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="新建分支名…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newBranchName.trim()) void handleCheckout(newBranchName, true);
              }}
            />
            <button
              type="button"
              className="button small secondary"
              disabled={!newBranchName.trim()}
              onClick={() => void handleCheckout(newBranchName, true)}
            >
              <Plus size={12} /> 创建
            </button>
          </div>
        </div>
      )}

      {/* Sub-navigation */}
      <div className="wt-subtabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'changes'}
          className={subTab === 'changes' ? 'active' : ''}
          onClick={() => setSubTab('changes')}
        >
          <FileDiff size={13} />
          <span>变更</span>
          {gitStatus?.files.length ? <em>{gitStatus.files.length}</em> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'files'}
          className={subTab === 'files' ? 'active' : ''}
          onClick={() => setSubTab('files')}
        >
          <FolderOpen size={13} />
          <span>文件</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'checkpoints'}
          className={subTab === 'checkpoints' ? 'active' : ''}
          onClick={() => setSubTab('checkpoints')}
        >
          <History size={13} />
          <span>检查点</span>
          {checkpoints.length ? <em>{checkpoints.length}</em> : null}
        </button>
      </div>

      {error && (
        <p className="wt-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-button" onClick={() => setError('')}>
            <X size={12} />
          </button>
        </p>
      )}

      {/* Floating Orca Annotation Tray */}
      {annotations.length > 0 && (
        <div className="wt-ann-tray">
          <div className="wt-ann-tray-top">
            <strong>
              <MessageSquarePlus size={13} /> 已批注 {annotations.length} 处代码
            </strong>
            <button type="button" className="link-button" onClick={() => setAnnotations([])}>
              清空
            </button>
          </div>
          <div className="wt-ann-tray-actions">
            <select
              aria-label="指定修改成员"
              value={annotationTarget}
              onChange={(e) => setAnnotationTarget(e.target.value)}
            >
              <option value="">发给全体讨论</option>
              {rosterMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  @{m.name} 修改
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button small primary"
              disabled={sendingAnnotations}
              onClick={() => void sendAnnotationsToRoom()}
            >
              {sendingAnnotations ? <LoaderCircle size={12} className="spin" /> : <Send size={12} />}
              发送返工
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="wt-body">
        {subTab === 'changes' && (
          <div className="wt-changes">
            {!gitStatus ? (
              <div className="wt-empty">
                <LoaderCircle size={18} className="spin" />
                <span>读取 Git 状态…</span>
              </div>
            ) : !gitStatus.isRepo ? (
              <div className="wt-empty">
                <GitBranch size={22} />
                <strong>当前目录未初始化 Git</strong>
                <small>初始化为本地 Git 仓库后，即可自动记录改动 Diff、写行级批注、创建安全检查点并随时回滚（仅存本地，不会推送）。</small>
                <button
                  type="button"
                  className="button small primary"
                  disabled={initializingGit}
                  onClick={() => void handleInitGit()}
                >
                  {initializingGit ? <LoaderCircle size={13} className="spin" /> : <GitBranch size={13} />}
                  一键初始化本地 Git 存档仓库
                </button>
              </div>
            ) : !gitStatus.files.length ? (
              <div className="wt-empty">
                <Check size={22} className="ok" />
                <strong>工作区干净</strong>
                <small>
                  {gitStatus.headShort ? `最新提交 ${gitStatus.headShort} · ${gitStatus.headMessage ?? ''}` : '暂无未提交改动'}
                </small>
              </div>
            ) : (
              <>
                <div className="wt-commit-box">
                  <input
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    placeholder="输入 Commit 说明，一键提交…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void handleCommit();
                    }}
                  />
                  <button
                    type="button"
                    className="button small primary"
                    disabled={committing || !commitMsg.trim()}
                    onClick={() => void handleCommit()}
                  >
                    {committing ? <LoaderCircle size={12} className="spin" /> : <GitCommitHorizontal size={13} />}
                    提交
                  </button>
                </div>
                <ul className="wt-file-list">
                  {gitStatus.files.map((file) => {
                    const annCount = annotations.filter((a) => a.path === file.path).length;
                    return (
                      <li key={file.path} className="wt-file-item">
                        <button
                          type="button"
                          className="wt-file-main"
                          onClick={() => void openFileDiff(file)}
                          title="点击查看 Diff 并写行级批注"
                        >
                          <span className={`wt-git-badge code-${file.code === '?' ? 'U' : file.code}`}>
                            {file.code}
                          </span>
                          <span className="wt-file-path">
                            <strong>{file.path.split('/').pop()}</strong>
                            {file.path.includes('/') && (
                              <small>{file.path.slice(0, file.path.lastIndexOf('/'))}</small>
                            )}
                          </span>
                          {annCount > 0 && <span className="wt-ann-badge">{annCount}</span>}
                          {(file.added > 0 || file.deleted > 0) && (
                            <span className="wt-file-stat">
                              {file.added > 0 && <em className="add">+{file.added}</em>}
                              {file.deleted > 0 && <em className="del">-{file.deleted}</em>}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="wt-file-revert"
                          title={file.code === '?' ? '删除未跟踪文件' : '撤销该文件改动'}
                          onClick={() => void handleRevertFile(file)}
                        >
                          {file.code === '?' ? <Trash2 size={12} /> : <Undo2 size={12} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        )}

        {subTab === 'files' && (
          <div className="wt-tree">
            {!treeMap[''] ? (
              <div className="wt-empty">
                <LoaderCircle size={18} className="spin" />
                <span>加载目录结构…</span>
              </div>
            ) : (
              renderTree('', 0)
            )}
          </div>
        )}

        {subTab === 'checkpoints' && (
          <div className="wt-checkpoints">
            <div className="wt-cp-create">
              <input
                value={cpLabel}
                onChange={(e) => setCpLabel(e.target.value)}
                placeholder="快照备注（如：重构右侧栏前）…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createCheckpointNow();
                }}
              />
              <button
                type="button"
                className="button small primary"
                disabled={cpBusy || !gitStatus?.isRepo}
                onClick={() => void createCheckpointNow()}
              >
                {cpBusy ? <LoaderCircle size={12} className="spin" /> : <Plus size={13} />}
                保存快照
              </button>
            </div>
            {!gitStatus?.isRepo ? (
              <div className="wt-empty">
                <History size={22} />
                <strong>初始化本地 Git 后开启检查点</strong>
                <small>检查点使用隐式 Git Ref 存档，随时可一键对比和回滚，不污染提交记录。</small>
                <button
                  type="button"
                  className="button small primary"
                  disabled={initializingGit}
                  onClick={() => void handleInitGit()}
                >
                  {initializingGit ? <LoaderCircle size={13} className="spin" /> : <GitBranch size={13} />}
                  一键初始化本地 Git 存档仓库
                </button>
              </div>
            ) : !checkpoints.length ? (
              <div className="wt-empty">
                <History size={22} />
                <strong>暂无安全检查点</strong>
                <small>使用隐式 Git Ref 保存工作区快照，不污染提交历史。</small>
              </div>
            ) : (
              <ol className="wt-cp-timeline">
                {checkpoints.map((cp) => (
                  <li key={cp.id} className="wt-cp-card">
                    <div className="wt-cp-dot" />
                    <div className="wt-cp-content">
                      <div className="wt-cp-top">
                        <strong>{cp.label}</strong>
                        <span className="wt-cp-sha">{cp.headShort}</span>
                      </div>
                      <div className="wt-cp-meta">
                        <span>
                          <Clock size={11} /> {shortDateTime(cp.createdAt)}
                        </span>
                        {cp.branch && (
                          <span>
                            <GitBranch size={11} /> {cp.branch}
                          </span>
                        )}
                        <span>{cp.changedCount} 个改动文件</span>
                      </div>
                      <div className="wt-cp-actions">
                        <button
                          type="button"
                          className="button small quiet"
                          onClick={() => void previewCheckpointDiff(cp)}
                        >
                          <FileDiff size={12} /> 对比差异
                        </button>
                        <button
                          type="button"
                          className="button small secondary"
                          disabled={cpBusy}
                          onClick={() => void restoreCheckpointNow(cp)}
                        >
                          <RotateCcw size={12} /> 回滚到此点
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      {/* Collapsible Orca Script Runner Drawer */}
      {scriptsOpen && (
        <section className="wt-scripts" aria-label="项目脚本运行器">
          <header className="wt-scripts-head">
            <span>
              <Terminal size={13} /> 脚本运行器
            </span>
            <button type="button" className="icon-button" onClick={() => onToggleScripts(false)}>
              <X size={13} />
            </button>
          </header>
          <div className="wt-script-pills">
            {scripts.slice(0, 8).map((sc) => (
              <button
                key={sc.id}
                type="button"
                className="wt-script-pill"
                disabled={Boolean(runningCmd)}
                title={sc.command}
                onClick={() => void runCommand(sc.command)}
              >
                {runningCmd === sc.command ? <LoaderCircle size={11} className="spin" /> : <Play size={11} />}
                <span>{sc.name}</span>
              </button>
            ))}
          </div>
          <div className="wt-script-input">
            <input
              value={customCmd}
              onChange={(e) => setCustomCmd(e.target.value)}
              placeholder="输入命令后回车运行（如 npm test）…"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customCmd.trim()) void runCommand(customCmd);
              }}
            />
            <button
              type="button"
              className="button small secondary"
              disabled={Boolean(runningCmd) || !customCmd.trim()}
              onClick={() => void runCommand(customCmd)}
            >
              运行
            </button>
          </div>
          {lastRun && (
            <div className="wt-script-output">
              <div className="wt-script-status">
                <span className={`wt-exit-pill ${lastRun.ok ? 'ok' : 'bad'}`}>
                  {lastRun.ok ? '✓ 0' : `✕ ${lastRun.exitCode}`} · {(lastRun.durationMs / 1000).toFixed(1)}s
                </span>
                <code>{lastRun.command}</code>
                {!lastRun.ok && (
                  <button
                    type="button"
                    className="button small primary wt-fix-btn"
                    disabled={sendingError}
                    onClick={() => void sendScriptErrorToAgent()}
                  >
                    {sendingError ? <LoaderCircle size={11} className="spin" /> : <Sparkles size={11} />}
                    交给成员修
                  </button>
                )}
              </div>
              <pre>{[lastRun.stdout, lastRun.stderr].filter(Boolean).join('\n').trim() || '（命令无输出）'}</pre>
            </div>
          )}
        </section>
      )}

      {/* Orca Annotated Diff Modal */}
      {diffModal && (
        <Modal
          title={diffModal.title}
          subtitle="点击任意代码行即可添加批注；批注可跨多个文件累积后一键打包发给成员修改。"
          className="wt-diff-modal"
          onClose={() => setDiffModal(null)}
        >
          <div className="modal-body wt-diff-body">
            {diffModal.isBinary ? (
              <div className="wt-empty">
                <strong>二进制文件，无法文本对比</strong>
              </div>
            ) : !diffModal.diff.trim() ? (
              <div className="wt-empty">
                <strong>暂无可显示的文本差异</strong>
              </div>
            ) : (
              <div className="wt-diff-table" role="region" aria-label="代码差异">
                {parsedDiffLines.map((line, idx) => {
                  const lineNo = line.newLine ?? line.oldLine;
                  const side: 'new' | 'old' = line.newLine !== undefined ? 'new' : 'old';
                  const clickable = line.kind === 'add' || line.kind === 'del' || line.kind === 'ctx';
                  const lineAnns =
                    clickable && lineNo !== undefined
                      ? annotations.filter((a) => a.path === diffModal.path && a.line === lineNo && a.side === side)
                      : [];
                  const isDrafting =
                    clickable && draftLine && draftLine.line === lineNo && draftLine.side === side;

                  return (
                    <div key={idx} className={`wt-diff-row kind-${line.kind}`}>
                      <div
                        className={`wt-diff-line ${clickable ? 'clickable' : ''}`}
                        onClick={() => {
                          if (!clickable || lineNo === undefined) return;
                          setDraftLine({ line: lineNo, side, codeLine: line.text });
                          setDraftText('');
                        }}
                      >
                        <span className="wt-ln old">{line.oldLine ?? ''}</span>
                        <span className="wt-ln new">{line.newLine ?? ''}</span>
                        <span className="wt-sign">
                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : clickable ? ' ' : ''}
                        </span>
                        <code className="wt-code">{line.text || ' '}</code>
                        {clickable && (
                          <span className="wt-add-ann" title="在此行写批注">
                            <MessageSquarePlus size={12} />
                          </span>
                        )}
                      </div>
                      {lineAnns.map((ann) => (
                        <div key={ann.id} className="wt-inline-ann">
                          <span>
                            <strong>第 {ann.line} 行批注：</strong>
                            {ann.comment}
                          </span>
                          <button
                            type="button"
                            className="icon-button"
                            title="删除批注"
                            onClick={() => setAnnotations((prev) => prev.filter((x) => x.id !== ann.id))}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                      {isDrafting && (
                        <div className="wt-inline-draft">
                          <input
                            autoFocus
                            value={draftText}
                            onChange={(e) => setDraftText(e.target.value)}
                            placeholder={`对第 ${lineNo} 行的修改意见…（Enter 确认）`}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                addAnnotation();
                              } else if (e.key === 'Escape') {
                                setDraftLine(null);
                              }
                            }}
                          />
                          <button type="button" className="button small primary" onClick={addAnnotation}>
                            添加批注
                          </button>
                          <button type="button" className="button small quiet" onClick={() => setDraftLine(null)}>
                            取消
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="modal-footer wt-diff-footer">
            <span className="wt-diff-hint">
              {annotations.length > 0
                ? `已累计 ${annotations.length} 条批注`
                : '提示：点击任意代码行即可写行级批注'}
            </span>
            <div className="wt-diff-footer-right">
              {annotations.length > 0 && (
                <>
                  <select
                    aria-label="指定修改成员"
                    value={annotationTarget}
                    onChange={(e) => setAnnotationTarget(e.target.value)}
                  >
                    <option value="">发给全体讨论</option>
                    {rosterMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        @{m.name} 修改
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="button primary"
                    disabled={sendingAnnotations}
                    onClick={() => void sendAnnotationsToRoom()}
                  >
                    {sendingAnnotations ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}
                    发送 {annotations.length} 条批注给成员
                  </button>
                </>
              )}
              <button type="button" className="button quiet" onClick={() => setDiffModal(null)}>
                关闭
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
