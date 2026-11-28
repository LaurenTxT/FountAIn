import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemberProfile, Project, RoomId, Run } from '../shared/types';
import {
  type FanoutCandidate,
  type FanoutState,
  type GitChangedFile,
  type GitFileCode,
  type ProjectCheckpointItem,
  type ProjectGitDiffResult,
  type ProjectGitStatus,
  type ProjectScriptItem,
  type ProjectScriptRunResult,
  type ProjectTreeEntry,
  type SelfHealDispatchResult,
} from '../shared/workspace-tools';
import { resolveSafePath } from './security';
import type { Store } from './store';

const TREE_EXCLUDED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
  '.fountain-smoke',
]);

const CHECKPOINT_REF_PREFIX = 'refs/fountain-checkpoints/';
const MAX_DIFF_CHARS = 160_000;
const MAX_SCRIPT_OUTPUT = 60_000;

export interface WorkspaceToolsHost {
  changed(): void;
  dataDirectory(): string;
  sendRoomMessage(roomId: RoomId, text: string, memberIds: string[]): Promise<unknown>;
  runIsolatedWritable(
    projectId: string,
    member: MemberProfile,
    title: string,
    prompt: string,
  ): Promise<{ sessionId: string; text: string; status: string; error?: string }>;
  getSessionDiff(sessionId: string): Promise<{ diff: string; files: string[] }>;
  applySessionWorkspace(sessionId: string): Promise<unknown>;
}

function runGit(
  cwd: string,
  args: string[],
  timeout = 20_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
      },
    );
  });
}

function countDiffLines(diff: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) deleted++;
  }
  return { added, deleted };
}

function parsePorcelainCode(x: string, y: string): { code: GitFileCode; staged: boolean } {
  if (x === '?' && y === '?') return { code: '?', staged: false };
  if (x === 'U' || y === 'U') return { code: 'U', staged: false };
  const staged = x !== ' ' && x !== '?';
  const raw = staged ? x : y;
  if (raw === 'A') return { code: 'A', staged };
  if (raw === 'D') return { code: 'D', staged };
  if (raw === 'R') return { code: 'R', staged };
  return { code: 'M', staged };
}

export class WorkspaceToolsController {
  private fanouts = new Map<string, FanoutState>();

  constructor(private store: Store, private host: WorkspaceToolsHost) {}

  private project(projectId: string): Project {
    const project = this.store.get<Project>('projects', projectId);
    if (!project) throw new Error('找不到该项目。');
    return project;
  }

  private member(memberId: string): MemberProfile {
    const m = this.store.members().find((item) => item.id === memberId);
    if (!m) throw new Error('找不到指定成员。');
    return m;
  }

  async gitStatus(projectId: string): Promise<ProjectGitStatus> {
    const project = this.project(projectId);
    const cwd = project.directory;
    const probe = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (probe.code !== 0 || probe.stdout.trim() !== 'true') {
      return {
        isRepo: false,
        branch: '',
        branches: [],
        ahead: 0,
        behind: 0,
        files: [],
        totalAdded: 0,
        totalDeleted: 0,
      };
    }

    const [branchRes, branchesRes, statusRes, numstatUnstaged, numstatStaged, headRes] =
      await Promise.all([
        runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
        runGit(cwd, ['branch', '--format=%(refname:short)']),
        runGit(cwd, ['status', '--porcelain=v1', '-b']),
        runGit(cwd, ['diff', '--numstat']),
        runGit(cwd, ['diff', '--cached', '--numstat']),
        runGit(cwd, ['log', '-1', '--format=%h%x09%s']),
      ]);

    const branch = branchRes.stdout.trim() || 'HEAD';
    const branches = branchesRes.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const stats = new Map<string, { added: number; deleted: number }>();
    const addNumstat = (raw: string) => {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [a, d, ...rest] = line.split('\t');
        const filePath = rest.join('\t').trim();
        if (!filePath) continue;
        const prev = stats.get(filePath) ?? { added: 0, deleted: 0 };
        stats.set(filePath, {
          added: prev.added + (Number.isFinite(Number(a)) ? Number(a) : 0),
          deleted: prev.deleted + (Number.isFinite(Number(d)) ? Number(d) : 0),
        });
      }
    };
    addNumstat(numstatUnstaged.stdout);
    addNumstat(numstatStaged.stdout);

    let ahead = 0;
    let behind = 0;
    const files: GitChangedFile[] = [];
    for (const line of statusRes.stdout.split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith('## ')) {
        const aMatch = line.match(/ahead (\d+)/);
        const bMatch = line.match(/behind (\d+)/);
        if (aMatch) ahead = Number(aMatch[1]);
        if (bMatch) behind = Number(bMatch[1]);
        continue;
      }
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      let rel = line.slice(3).trim();
      if (rel.includes(' -> ')) rel = rel.split(' -> ').pop()!.trim();
      if (rel.startsWith('"') && rel.endsWith('"')) {
        try {
          rel = JSON.parse(rel);
        } catch {
          rel = rel.slice(1, -1);
        }
      }
      const { code, staged } = parsePorcelainCode(x, y);
      const st = stats.get(rel) ?? { added: 0, deleted: 0 };
      files.push({ path: rel, code, staged, added: st.added, deleted: st.deleted });
    }

    const totalAdded = files.reduce((sum, f) => sum + f.added, 0);
    const totalDeleted = files.reduce((sum, f) => sum + f.deleted, 0);
    const [headShort, headMessage] = headRes.code === 0 ? headRes.stdout.trim().split('\t') : [];

    return {
      isRepo: true,
      branch,
      branches,
      ahead,
      behind,
      files,
      totalAdded,
      totalDeleted,
      headShort,
      headMessage,
    };
  }

  async gitDiff(projectId: string, relativePath?: string): Promise<ProjectGitDiffResult> {
    const project = this.project(projectId);
    const cwd = project.directory;
    const rel = relativePath?.trim() ?? '';
    if (rel) {
      // Check if untracked first so we can render a full added-file diff
      const st = await runGit(cwd, ['status', '--porcelain=v1', '--', rel]);
      if (st.stdout.startsWith('?? ')) {
        const abs = resolveSafePath(cwd, rel);
        try {
          const buf = await readFile(abs);
          if (buf.includes(0)) {
            return { relativePath: rel, diff: '', isUntracked: true, isBinary: true };
          }
          const text = buf.toString('utf8').slice(0, MAX_DIFF_CHARS);
          const lines = text.split(/\r?\n/);
          const synthetic = [
            `diff --git a/${rel} b/${rel}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${rel}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((l) => `+${l}`),
          ].join('\n');
          return { relativePath: rel, diff: synthetic, isUntracked: true };
        } catch {
          return { relativePath: rel, diff: '', isUntracked: true };
        }
      }
      const headDiff = await runGit(cwd, ['diff', 'HEAD', '--', rel]);
      const diff = (headDiff.code === 0 ? headDiff.stdout : (await runGit(cwd, ['diff', '--', rel])).stdout).slice(
        0,
        MAX_DIFF_CHARS,
      );
      return { relativePath: rel, diff };
    }
    const allDiff = await runGit(cwd, ['diff', 'HEAD']);
    return {
      relativePath: '',
      diff: (allDiff.code === 0 ? allDiff.stdout : (await runGit(cwd, ['diff'])).stdout).slice(
        0,
        MAX_DIFF_CHARS,
      ),
    };
  }

  async gitInit(projectId: string): Promise<{ branch: string; baselineCommit?: string }> {
    const project = this.project(projectId);
    const cwd = project.directory;
    const probe = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (probe.code !== 0 || probe.stdout.trim() !== 'true') {
      const initRes = await runGit(cwd, ['init', '-b', 'main']);
      if (initRes.code !== 0) {
        const fallback = await runGit(cwd, ['init']);
        if (fallback.code !== 0) throw new Error(fallback.stderr.trim() || 'git init 失败。');
      }
      const gitignore = path.join(cwd, '.gitignore');
      if (!existsSync(gitignore)) {
        await writeFile(
          gitignore,
          'node_modules/\n__pycache__/\n.venv/\nvenv/\n*.pyc\n.DS_Store\nThumbs.db\n',
          'utf8',
        );
      }
    }
    const hasHead = (await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])).code === 0;
    let baselineCommit: string | undefined;
    if (!hasHead) {
      await runGit(cwd, ['add', '-A']);
      const nameCheck = await runGit(cwd, ['config', 'user.name']);
      const emailCheck = await runGit(cwd, ['config', 'user.email']);
      const commitArgs = [
        ...(nameCheck.stdout.trim() ? [] : ['-c', 'user.name=FountAIn Workspace']),
        ...(emailCheck.stdout.trim() ? [] : ['-c', 'user.email=workspace@local']),
        'commit',
        '--allow-empty',
        '-m',
        'chore: initial baseline snapshot',
      ];
      const committed = await runGit(cwd, commitArgs);
      if (committed.code === 0) {
        baselineCommit = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
      }
    }
    const branch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
    return { branch, baselineCommit };
  }

  async gitCommit(projectId: string, message: string, files?: string[]): Promise<{ commit: string }> {
    const project = this.project(projectId);
    const msg = message.trim();
    if (!msg) throw new Error('请输入提交说明（Commit message）。');
    const cwd = project.directory;
    const addArgs = files && files.length ? ['add', '--', ...files] : ['add', '-A'];
    const added = await runGit(cwd, addArgs);
    if (added.code !== 0) throw new Error(added.stderr.trim() || 'git add 失败。');
    const committed = await runGit(cwd, ['commit', '-m', msg]);
    if (committed.code !== 0) {
      throw new Error(committed.stderr.trim() || committed.stdout.trim() || 'git commit 失败。');
    }
    const sha = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    return { commit: sha };
  }

  async gitRevertFile(projectId: string, relativePath: string, untracked?: boolean): Promise<{ ok: true }> {
    const project = this.project(projectId);
    const rel = relativePath.trim();
    if (!rel) throw new Error('缺少文件路径。');
    const cwd = project.directory;
    resolveSafePath(cwd, rel);
    if (untracked) {
      const target = resolveSafePath(cwd, rel);
      await unlink(target);
      return { ok: true };
    }
    await runGit(cwd, ['reset', 'HEAD', '--', rel]);
    const res = await runGit(cwd, ['checkout', '--', rel]);
    if (res.code !== 0) throw new Error(res.stderr.trim() || '撤销文件改动失败。');
    return { ok: true };
  }

  async gitCheckout(projectId: string, branch: string, create?: boolean): Promise<{ branch: string }> {
    const project = this.project(projectId);
    const name = branch.trim();
    if (!name || /[\s~^:?*\\[\]]/.test(name)) throw new Error('分支名格式不合法。');
    const args = create ? ['checkout', '-b', name] : ['checkout', name];
    const res = await runGit(project.directory, args);
    if (res.code !== 0) throw new Error(res.stderr.trim() || '切换分支失败。');
    return { branch: name };
  }

  async listTree(projectId: string, dir = ''): Promise<ProjectTreeEntry[]> {
    const project = this.project(projectId);
    const relDir = dir.trim().replace(/^[/\\]+/, '');
    const target = relDir ? resolveSafePath(project.directory, relDir) : project.directory;
    const raw = await readdir(target, { withFileTypes: true });
    const entries: ProjectTreeEntry[] = [];
    for (const item of raw) {
      if (TREE_EXCLUDED.has(item.name)) continue;
      const entryRel = relDir ? `${relDir}/${item.name}` : item.name;
      let size: number | undefined;
      if (item.isFile()) {
        try {
          size = (await stat(path.join(target, item.name))).size;
        } catch {
          size = undefined;
        }
      }
      entries.push({
        name: item.name,
        path: entryRel.replaceAll('\\', '/'),
        isDir: item.isDirectory(),
        size,
      });
    }
    return entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async writeProjectFile(projectId: string, relativePath: string, content: string): Promise<{ path: string; bytes: number }> {
    const project = this.project(projectId);
    const rel = relativePath.trim().replace(/^[/\\]+/, '');
    if (!rel) throw new Error('缺少文件路径。');
    const abs = resolveSafePath(project.directory, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const buf = Buffer.from(content, 'utf8');
    await writeFile(abs, buf);
    return { path: rel.replaceAll('\\', '/'), bytes: buf.length };
  }

  async importProjectFiles(params: {
    projectId: string;
    targetDir?: string;
    paths?: string[];
    files?: { name: string; bytes: Uint8Array | number[] }[];
  }): Promise<{ imported: string[] }> {
    const project = this.project(params.projectId);
    const relDir = (params.targetDir ?? '').trim().replace(/^[/\\]+/, '');
    const destDir = relDir ? resolveSafePath(project.directory, relDir) : project.directory;
    await mkdir(destDir, { recursive: true });

    const uniqueDest = (baseName: string) => {
      const clean = path.basename(baseName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
      const parsed = path.parse(clean);
      let candidate = clean;
      let n = 1;
      while (existsSync(path.join(destDir, candidate))) {
        candidate = `${parsed.name} (${n++})${parsed.ext}`;
      }
      return {
        abs: resolveSafePath(project.directory, relDir ? `${relDir}/${candidate}` : candidate),
        rel: (relDir ? `${relDir}/${candidate}` : candidate).replaceAll('\\', '/'),
      };
    };

    const imported: string[] = [];
    for (const srcPath of params.paths ?? []) {
      const trimmed = String(srcPath ?? '').trim();
      if (!trimmed || !existsSync(trimmed)) continue;
      const dest = uniqueDest(path.basename(trimmed));
      if (path.resolve(trimmed).toLowerCase() === path.resolve(dest.abs).toLowerCase()) continue;
      await cp(trimmed, dest.abs, { recursive: true });
      imported.push(dest.rel);
    }
    for (const item of params.files ?? []) {
      if (!item?.name) continue;
      const dest = uniqueDest(item.name);
      const buf = Buffer.from(item.bytes instanceof Uint8Array ? item.bytes : Uint8Array.from(item.bytes ?? []));
      await writeFile(dest.abs, buf);
      imported.push(dest.rel);
    }
    return { imported };
  }

  async listScripts(projectId: string): Promise<ProjectScriptItem[]> {
    const project = this.project(projectId);
    const cwd = project.directory;
    const items: ProjectScriptItem[] = [];
    const pkgFile = path.join(cwd, 'package.json');
    if (existsSync(pkgFile)) {
      try {
        const parsed = JSON.parse(await readFile(pkgFile, 'utf8')) as {
          scripts?: Record<string, string>;
        };
        const scripts = parsed.scripts ?? {};
        for (const [name, cmd] of Object.entries(scripts)) {
          items.push({
            id: `pkg:${name}`,
            name,
            command: `npm run ${name}`,
            source: 'package.json',
          });
          void cmd;
        }
      } catch {
        // Ignore malformed package.json
      }
    }
    if (existsSync(path.join(cwd, 'pyproject.toml')) || existsSync(path.join(cwd, 'pytest.ini'))) {
      items.push({ id: 'preset:pytest', name: 'pytest', command: 'pytest', source: 'preset' });
    }
    const isGit = (await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])).code === 0;
    if (isGit) {
      items.push({ id: 'preset:git-status', name: 'git status', command: 'git status -s', source: 'preset' });
    }
    return items;
  }

  async runScript(projectId: string, command: string): Promise<ProjectScriptRunResult> {
    const project = this.project(projectId);
    const cmd = command.trim();
    if (!cmd) throw new Error('请输入要运行的命令。');
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(cmd, {
        cwd: project.directory,
        shell: true,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const append = (cur: string, chunk: Buffer) => {
        if (cur.length >= MAX_SCRIPT_OUTPUT) {
          truncated = true;
          return cur;
        }
        return cur + chunk.toString('utf8').slice(0, MAX_SCRIPT_OUTPUT - cur.length);
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const timer = setTimeout(() => {
        child.kill();
        stderr += '\n[FountAIn] 命令执行超过 90 秒已自动中止。';
      }, 90_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        const exitCode = code ?? 1;
        resolve({
          command: cmd,
          exitCode,
          ok: exitCode === 0,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          truncated,
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          command: cmd,
          exitCode: 1,
          ok: false,
          stdout,
          stderr: err.message,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  /** T3 Code-style hidden Git ref checkpoints (never pollutes git log or branch history). */
  async listCheckpoints(projectId: string): Promise<ProjectCheckpointItem[]> {
    const project = this.project(projectId);
    const cwd = project.directory;
    const probe = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (probe.code !== 0) return [];
    const refs = await runGit(cwd, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname)%x09%(objectname:short)%x09%(committerdate:iso-strict)%x09%(subject)',
      CHECKPOINT_REF_PREFIX,
    ]);
    if (refs.code !== 0) return [];
    const items: ProjectCheckpointItem[] = [];
    for (const line of refs.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [refName, headShort, createdAt, subject] = line.split('\t');
      const id = refName.slice(CHECKPOINT_REF_PREFIX.length);
      let label = subject || id;
      let branch = '';
      let changedCount = 0;
      const metaMatch = label.match(/^\[([^|\]]+)\|(\d+)\]\s*(.*)$/);
      if (metaMatch) {
        branch = metaMatch[1];
        changedCount = Number(metaMatch[2]) || 0;
        label = metaMatch[3] || '安全检查点';
      }
      items.push({ id, refName, label, createdAt, branch, headShort, changedCount });
    }
    return items.slice(0, 30);
  }

  async createCheckpoint(projectId: string, label?: string): Promise<ProjectCheckpointItem> {
    const project = this.project(projectId);
    const cwd = project.directory;
    const probe = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (probe.code !== 0) throw new Error('当前项目不是 Git 仓库，无法创建检查点。');

    const status = await this.gitStatus(projectId);
    const branch = status.branch || 'HEAD';
    const cleanLabel = (label?.trim() || '手动检查点').replace(/[\r\n\t]+/g, ' ').slice(0, 80);
    const id = `cp-${Date.now()}`;
    const refName = `${CHECKPOINT_REF_PREFIX}${id}`;

    // Build a temporary index snapshot including untracked files without touching the real index
    const gitDir = (await runGit(cwd, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    const tmpIndex = path.join(gitDir, `fountain-cp-${Date.now()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const runWithTmp = (args: string[]) =>
      new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        execFile('git', args, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out, errOut) =>
          resolve({ stdout: String(out ?? ''), stderr: String(errOut ?? ''), code: err ? 1 : 0 }),
        );
      });

    try {
      await runWithTmp(['read-tree', 'HEAD']);
      await runWithTmp(['add', '-A']);
      const treeRes = await runWithTmp(['write-tree']);
      if (treeRes.code !== 0) throw new Error(treeRes.stderr || '写入检查点树失败。');
      const treeSha = treeRes.stdout.trim();
      const headSha = (await runGit(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
      const msg = `[${branch}|${status.files.length}] ${cleanLabel}`;
      const commitArgs = headSha
        ? ['commit-tree', treeSha, '-p', headSha, '-m', msg]
        : ['commit-tree', treeSha, '-m', msg];
      const commitRes = await runGit(cwd, commitArgs);
      if (commitRes.code !== 0) throw new Error(commitRes.stderr || '创建检查点对象失败。');
      const commitSha = commitRes.stdout.trim();
      const upd = await runGit(cwd, ['update-ref', refName, commitSha]);
      if (upd.code !== 0) throw new Error(upd.stderr || '保存检查点引用失败。');
      return {
        id,
        refName,
        label: cleanLabel,
        createdAt: new Date().toISOString(),
        branch,
        headShort: commitSha.slice(0, 7),
        changedCount: status.files.length,
      };
    } finally {
      await unlink(tmpIndex).catch(() => {});
    }
  }

  async diffCheckpoint(projectId: string, checkpointId: string): Promise<{ diff: string }> {
    const project = this.project(projectId);
    const refName = `${CHECKPOINT_REF_PREFIX}${checkpointId}`;
    const res = await runGit(project.directory, ['diff', refName]);
    return { diff: res.stdout.slice(0, MAX_DIFF_CHARS) };
  }

  async restoreCheckpoint(projectId: string, checkpointId: string): Promise<{ safetyCheckpoint: ProjectCheckpointItem }> {
    const project = this.project(projectId);
    const refName = `${CHECKPOINT_REF_PREFIX}${checkpointId}`;
    const verify = await runGit(project.directory, ['rev-parse', '--verify', refName]);
    if (verify.code !== 0) throw new Error('找不到该检查点。');
    // Always capture a safety checkpoint before restoring!
    const safetyCheckpoint = await this.createCheckpoint(projectId, `回滚前自动备份 (${checkpointId})`);
    const res = await runGit(project.directory, ['checkout', refName, '--', '.']);
    if (res.code !== 0) throw new Error(res.stderr.trim() || '恢复检查点失败。');
    return { safetyCheckpoint };
  }

  /** Orca-style 1-to-N Parallel Code Fan-out & Winner Selection. */
  getFanout(projectId: string): FanoutState | null {
    return this.fanouts.get(projectId) ?? this.store.get<FanoutState>('fanout_states', projectId) ?? null;
  }

  private saveFanout(state: FanoutState): FanoutState {
    const next = { ...state, updatedAt: new Date().toISOString() };
    this.fanouts.set(next.projectId, next);
    this.store.put('fanout_states', next.projectId, next);
    this.host.changed();
    return next;
  }

  async startFanout(params: {
    projectId: string;
    prompt: string;
    memberIds: string[];
  }): Promise<FanoutState> {
    const project = this.project(params.projectId);
    const prompt = params.prompt.trim();
    if (!prompt) throw new Error('请输入要并行盲写的开发任务说明。');
    const uniqueMembers = [...new Set(params.memberIds)].slice(0, 3);
    if (uniqueMembers.length < 2) throw new Error('请至少选择 2 位成员进行并行盲写。');

    const now = new Date().toISOString();
    const state: FanoutState = {
      id: `fanout-${Date.now()}`,
      projectId: project.id,
      prompt,
      status: 'running',
      candidates: uniqueMembers.map((memberId) => ({
        memberId,
        status: 'running',
        summary: '',
        changedFiles: [],
        addedLines: 0,
        deletedLines: 0,
        startedAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    };
    this.saveFanout(state);

    // Run all selected members in parallel in their own isolated writable workspaces
    void Promise.all(
      uniqueMembers.map(async (memberId) => {
        try {
          const member = this.member(memberId);
          const wrappedPrompt = [
            '你正在参与【Orca 并行盲写比稿】（独立工作副本，不会干扰主目录或其他成员）。',
            '请直接动手修改代码并尽可能自检，最后用 3–5 句话简明总结你的实现思路、改动文件和验证结果。',
            '',
            `任务需求：\n${prompt}`,
          ].join('\n');
          const res = await this.host.runIsolatedWritable(
            project.id,
            member,
            `并行盲写 · ${prompt.slice(0, 28)}`,
            wrappedPrompt,
          );
          let diff = '';
          let changedFiles: string[] = [];
          try {
            const d = await this.host.getSessionDiff(res.sessionId);
            diff = d.diff.slice(0, MAX_DIFF_CHARS);
            changedFiles = d.files;
          } catch {
            // Keep empty diff if session had no file changes
          }
          const counts = countDiffLines(diff);
          this.updateCandidate(project.id, memberId, {
            sessionId: res.sessionId,
            status: res.status === 'completed' ? 'completed' : 'failed',
            summary: res.text || (res.error ? `执行失败：${res.error}` : '已完成。'),
            error: res.error,
            diff,
            changedFiles,
            addedLines: counts.added,
            deletedLines: counts.deleted,
            finishedAt: new Date().toISOString(),
          });
        } catch (err) {
          this.updateCandidate(project.id, memberId, {
            status: 'failed',
            summary: '',
            error: (err as Error).message,
            finishedAt: new Date().toISOString(),
          });
        }
      }),
    );

    return state;
  }

  private updateCandidate(projectId: string, memberId: string, patch: Partial<FanoutCandidate>) {
    const current = this.getFanout(projectId);
    if (!current) return;
    const candidates = current.candidates.map((c) => (c.memberId === memberId ? { ...c, ...patch } : c));
    const stillRunning = candidates.some((c) => c.status === 'running');
    this.saveFanout({
      ...current,
      candidates,
      status: stillRunning ? 'running' : current.status === 'adopted' ? 'adopted' : 'ready',
    });
  }

  async adoptFanout(projectId: string, memberId: string): Promise<FanoutState> {
    const current = this.getFanout(projectId);
    if (!current) throw new Error('当前没有可采纳的并行盲写记录。');
    const winner = current.candidates.find((c) => c.memberId === memberId);
    if (!winner?.sessionId) throw new Error('找不到该成员的独立工作副本。');
    // Create a T3-style safety checkpoint before applying winner changes
    await this.createCheckpoint(projectId, `采纳并行盲写前自动备份 (${memberId})`).catch(() => {});
    await this.host.applySessionWorkspace(winner.sessionId);
    return this.saveFanout({
      ...current,
      status: 'adopted',
      adoptedMemberId: memberId,
    });
  }

  resetFanout(projectId: string): { ok: true } {
    this.fanouts.delete(projectId);
    this.store.delete('fanout_states', projectId);
    this.host.changed();
    return { ok: true };
  }

  async saveManualNote(projectId: string, relPath: string, content: string): Promise<void> {
    const project = this.project(projectId);
    const abs = resolveSafePath(project.directory, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  /** Collect latest error logs & dispatch a self-repair ticket directly to the offending member ("谁出的问题谁负责"). */
  async dispatchSelfHeal(params: {
    projectId?: string;
    memberId?: string;
    errorSummary?: string;
    scope?: 'software' | 'project';
    runId?: string;
  }): Promise<SelfHealDispatchResult> {
    const allProjects = this.store.list<Project>('projects').filter((p) => !p.kind);
    const sourceProject = params.projectId
      ? allProjects.find((p) => p.id === params.projectId)
      : undefined;

    // Detect FountAIn source repo among registered projects when scope === 'software'
    let softwareRepo: Project | undefined;
    for (const p of allProjects) {
      const pkgPath = path.join(p.directory, 'package.json');
      const enginePath = path.join(p.directory, 'src', 'backend', 'engine.ts');
      if (existsSync(pkgPath) && existsSync(enginePath)) {
        try {
          const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { name?: string };
          if (pkg.name === 'fountain') {
            softwareRepo = p;
            break;
          }
        } catch {
          // Ignore malformed package.json
        }
      }
    }

    const isSoftwareRepo = params.scope === 'software' && Boolean(softwareRepo);
    if (params.scope === 'software' && !softwareRepo)
      throw new Error('请先在工作台添加 FountAIn 源码目录，再派发软件修复。');
    const targetProject = (isSoftwareRepo ? softwareRepo : sourceProject) ?? softwareRepo ?? allProjects[0];
    if (!targetProject) throw new Error('请先在工作台添加项目（若需自修 FountAIn 软件本身，请添加 FountAIn 源码目录）。');

    // Collect recent failed runs & log errors
    const recentFailedRuns = this.store
      .list<Run>('runs')
      .filter((r) => ['failed', 'unknown'].includes(r.status) || Boolean(r.error))
      .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')))
      .slice(0, 4);
    const matchedRun =
      params.runId ? this.store.get<Run>('runs', params.runId)
        : recentFailedRuns.find(r => !sourceProject || r.projectId === sourceProject.id);

    // Honor explicit repair assignments; infer an assignee only for legacy callers.
    const members = this.store.members().filter((m) => !m.cardHidden);
    if (params.memberId && !members.some(member => member.id === params.memberId))
      throw new Error('所选修复成员已不可用，请重新选择。');
    const inferredMember =
      (params.memberId ? members.find((m) => m.id === params.memberId) : undefined) ??
      (matchedRun?.provider ? members.find((m) => m.executor === matchedRun.provider) : undefined) ??
      (targetProject.meetingLeaderId ? members.find((m) => m.id === targetProject.meetingLeaderId) : undefined) ??
      members.find((m) => m.id === 'codex') ??
      members[0];
    if (!inferredMember) throw new Error('找不到可指派的成员。');

    // Read today's log file tail for concrete error context
    let logTail = '';
    try {
      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(this.host.dataDirectory(), 'logs', `${today}.jsonl`);
      if (existsSync(logFile)) {
        const raw = await readFile(logFile, 'utf8');
        const errLines = raw
          .split(/\r?\n/)
          .filter((line) => Boolean(matchedRun && line.includes(matchedRun.id)))
          .slice(-6)
          .map((line) => {
            try {
              const obj = JSON.parse(line) as { at?: string; provider?: string; text?: string };
              return `[${obj.at ?? ''}] (${obj.provider ?? ''}) ${String(obj.text ?? '').slice(0, 300)}`;
            } catch {
              return line.slice(0, 300);
            }
          });
        if (errLines.length) logTail = errLines.join('\n');
      }
    } catch {
      // Optional diagnostic context
    }

    const summary =
      params.errorSummary?.trim() ||
      matchedRun?.error ||
      '软件运行中出现异常，请定位根因并修复。';

    const targetRoomId = `project:${targetProject.id}` as RoomId;
    const roster = targetProject.memberIds?.length
      ? [...new Set([...targetProject.memberIds, inferredMember.id])]
      : members.map((m) => m.id);

    const ticket = [
      `@${inferredMember.name} 【排障与修复工单】`,
      '',
      `- **来源项目**：${sourceProject?.name ?? targetProject.name}`,
      `- **问题摘要**：${summary}`,
      matchedRun ? `- **关联运行**：\`${matchedRun.id}\`（状态：${matchedRun.status}）` : '',
      logTail ? `\n**最近报错日志**：\n\`\`\`\n${logTail}\n\`\`\`` : '',
      '',
      isSoftwareRepo
        ? '请你直接在本仓库（FountAIn 源码）中定位根因并提出/实施最小改动修复，改完后必须跑完 `typecheck`、单元测试和 `build` 验证全绿，再向用户汇报改动与验证结果（由用户确认后重启生效）。'
        : '请你直接排查上述报错原因，修复或补全缺失的核验依据，验证通过后简明汇报结果。',
    ]
      .filter(Boolean)
      .join('\n');

    await this.host.sendRoomMessage(targetRoomId, ticket, roster);

    return {
      targetProjectId: targetProject.id,
      targetProjectName: targetProject.name,
      targetRoomId,
      memberId: inferredMember.id,
      memberName: inferredMember.name,
      isSoftwareRepo,
    };
  }
}
