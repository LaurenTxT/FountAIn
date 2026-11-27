export const WORKSPACE_TOOLS_READS = [
  'project.git.status',
  'project.git.diff',
  'project.tree',
  'project.scripts.list',
  'project.checkpoints.list',
  'project.checkpoints.diff',
  'project.fanout.get',
  'project.terminal.list',
  'project.terminal.read',
] as const;

export const WORKSPACE_TOOLS_WRITES = [
  'project.git.init',
  'project.git.commit',
  'project.git.revertFile',
  'project.git.checkout',
  'project.file.write',
  'project.file.import',
  'project.scripts.run',
  'project.checkpoints.create',
  'project.checkpoints.restore',
  'project.fanout.start',
  'project.fanout.adopt',
  'project.fanout.reset',
  'project.terminal.create',
  'project.terminal.write',
  'project.terminal.interrupt',
  'project.terminal.close',
  'project.terminal.launchMember',
] as const;

export const WORKSPACE_TOOLS_METHODS = [
  ...WORKSPACE_TOOLS_READS,
  ...WORKSPACE_TOOLS_WRITES,
] as const;

export type GitFileCode = 'M' | 'A' | 'D' | 'R' | '?' | 'U';

export interface GitChangedFile {
  path: string;
  code: GitFileCode;
  staged: boolean;
  added: number;
  deleted: number;
}

export interface ProjectGitStatus {
  isRepo: boolean;
  branch: string;
  branches: string[];
  ahead: number;
  behind: number;
  files: GitChangedFile[];
  totalAdded: number;
  totalDeleted: number;
  headShort?: string;
  headMessage?: string;
}

export interface ProjectGitDiffResult {
  relativePath: string;
  diff: string;
  isUntracked?: boolean;
  isBinary?: boolean;
}

export interface ProjectTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface ProjectScriptItem {
  id: string;
  name: string;
  command: string;
  source: 'package.json' | 'preset';
}

export interface ProjectScriptRunResult {
  command: string;
  exitCode: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated?: boolean;
}

export interface ProjectCheckpointItem {
  id: string;
  refName: string;
  label: string;
  createdAt: string;
  branch: string;
  headShort: string;
  changedCount: number;
}

export interface DiffAnnotation {
  id: string;
  path: string;
  line: number;
  side: 'new' | 'old';
  codeLine: string;
  comment: string;
}

export interface FanoutCandidate {
  memberId: string;
  sessionId?: string;
  status: 'running' | 'completed' | 'failed';
  summary: string;
  error?: string;
  diff?: string;
  changedFiles: string[];
  addedLines: number;
  deletedLines: number;
  startedAt: string;
  finishedAt?: string;
}

export interface FanoutState {
  id: string;
  projectId: string;
  prompt: string;
  status: 'idle' | 'running' | 'ready' | 'adopted';
  adoptedMemberId?: string;
  candidates: FanoutCandidate[];
  createdAt: string;
  updatedAt: string;
}

export interface TerminalTabSummary {
  id: string;
  projectId: string;
  title: string;
  kind: 'shell' | 'member';
  memberId?: string;
  alive: boolean;
  exitCode?: number | null;
  createdAt: string;
}

export interface TerminalOutputSnapshot extends TerminalTabSummary {
  output: string;
  seq: number;
}

export interface MemberTerminalLaunchResult {
  launched: boolean;
  title: string;
  command: string;
  handoffFile?: string;
  mode: 'windows-terminal' | 'native-console' | 'in-app';
}

/** Format Orca-style inline diff annotations into a concise, actionable prompt for an agent. */
export function formatDiffAnnotationsPrompt(
  annotations: DiffAnnotation[],
  targetMention?: string,
): string {
  const prefix = targetMention ? `@${targetMention} ` : '';
  const grouped = new Map<string, DiffAnnotation[]>();
  for (const item of annotations) {
    const list = grouped.get(item.path) ?? [];
    list.push(item);
    grouped.set(item.path, list);
  }
  const blocks: string[] = [];
  for (const [filePath, items] of grouped) {
    const lines = items
      .sort((a, b) => a.line - b.line)
      .map((a) => {
        const snippet = a.codeLine.trim().slice(0, 120);
        return `  - 第 ${a.line} 行${snippet ? `（\`${snippet}\`）` : ''}：${a.comment}`;
      })
      .join('\n');
    blocks.push(`- \`${filePath}\`\n${lines}`);
  }
  return `${prefix}请按以下 ${annotations.length} 条代码 Diff 行级批注定点修改：\n\n${blocks.join('\n\n')}\n\n改完后请简述每条批注的处理结果并自检。`;
}
