import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { MemberProfile, Project, ProviderInfo, RoomId, RoomMessage, Settings } from '../shared/types';
import type {
  MemberTerminalLaunchResult,
  TerminalOutputSnapshot,
  TerminalTabSummary,
} from '../shared/workspace-tools';
import type { Store } from './store';

const MAX_BUFFER_CHARS = 240_000;

interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (ev: { exitCode: number; signal?: number }) => void): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): PtyProcess;
}

let cachedPty: NodePtyModule | null | undefined;
function loadNodePty(): NodePtyModule | null {
  if (cachedPty !== undefined) return cachedPty;
  try {
    const req = createRequire(import.meta.url);
    cachedPty = req('node-pty') as NodePtyModule;
  } catch {
    cachedPty = null;
  }
  return cachedPty;
}

function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface TerminalHost {
  recentRoomMessages(roomId: RoomId, limit: number): RoomMessage[];
  resolveNodeExecutable(): string;
  resolveMemberEnv(member: MemberProfile): Record<string, string>;
}

interface LiveTerminal {
  id: string;
  projectId: string;
  title: string;
  kind: 'shell' | 'member';
  memberId?: string;
  pty?: PtyProcess;
  proc?: ChildProcess;
  isPty: boolean;
  buffer: string;
  baseOffset: number;
  totalOffset: number;
  alive: boolean;
  exitCode: number | null;
  createdAt: string;
}

export class TerminalManager {
  private sessions = new Map<string, LiveTerminal>();

  constructor(private store: Store, private host: TerminalHost) {}

  private project(projectId: string): Project {
    const project = this.store.get<Project>('projects', projectId);
    if (!project) throw new Error('找不到该项目。');
    return project;
  }

  list(projectId: string): TerminalTabSummary[] {
    const out: TerminalTabSummary[] = [];
    for (const s of this.sessions.values()) {
      if (s.projectId !== projectId) continue;
      out.push({
        id: s.id,
        projectId: s.projectId,
        title: s.title,
        kind: s.kind,
        memberId: s.memberId,
        alive: s.alive,
        exitCode: s.exitCode,
        createdAt: s.createdAt,
      });
    }
    return out;
  }

  read(terminalId: string, offset = 0): TerminalOutputSnapshot {
    const s = this.sessions.get(terminalId);
    if (!s) throw new Error('终端会话不存在或已关闭。');
    const safeOffset = Math.max(0, Math.floor(offset));
    let data = '';
    let reset = false;
    if (safeOffset === 0 || safeOffset < s.baseOffset) {
      data = s.buffer;
      reset = safeOffset > 0;
    } else if (safeOffset < s.totalOffset) {
      data = s.buffer.slice(safeOffset - s.baseOffset);
    }
    return {
      id: s.id,
      projectId: s.projectId,
      title: s.title,
      kind: s.kind,
      memberId: s.memberId,
      alive: s.alive,
      exitCode: s.exitCode,
      createdAt: s.createdAt,
      data,
      nextOffset: s.totalOffset,
      reset,
      isPty: s.isPty,
    };
  }

  private appendChunk(entry: LiveTerminal, chunk: string) {
    if (!chunk) return;
    entry.buffer += chunk;
    entry.totalOffset += chunk.length;
    if (entry.buffer.length > MAX_BUFFER_CHARS) {
      const drop = entry.buffer.length - MAX_BUFFER_CHARS;
      entry.buffer = entry.buffer.slice(drop);
      entry.baseOffset += drop;
    }
  }

  private spawnInApp(params: {
    projectId: string;
    cwd: string;
    title: string;
    kind: 'shell' | 'member';
    memberId?: string;
    file: string;
    args: string[];
    env?: Record<string, string | undefined>;
    cols?: number;
    rows?: number;
    initialCommand?: string;
  }): TerminalTabSummary {
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const ptyMod = loadNodePty();
    const cols = Math.max(40, Math.min(240, params.cols ?? 90));
    const rows = Math.max(12, Math.min(80, params.rows ?? 26));
    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...(params.env ?? {}),
    };

    const entry: LiveTerminal = {
      id,
      projectId: params.projectId,
      title: params.title,
      kind: params.kind,
      memberId: params.memberId,
      isPty: Boolean(ptyMod),
      buffer: '',
      baseOffset: 0,
      totalOffset: 0,
      alive: true,
      exitCode: null,
      createdAt: new Date().toISOString(),
    };

    if (ptyMod) {
      const pty = ptyMod.spawn(params.file, params.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: params.cwd,
        env: mergedEnv,
      });
      entry.pty = pty;
      pty.onData((data) => this.appendChunk(entry, data));
      pty.onExit(({ exitCode }) => {
        entry.alive = false;
        entry.exitCode = exitCode;
        this.appendChunk(entry, `\r\n\x1b[90m[终端进程已退出，退出码 ${exitCode}]\x1b[0m\r\n`);
      });
    } else {
      const proc = spawn(params.file, params.args, {
        cwd: params.cwd,
        windowsHide: true,
        env: mergedEnv,
      });
      entry.proc = proc;
      proc.stdout?.on('data', (d: Buffer) => this.appendChunk(entry, d.toString('utf8')));
      proc.stderr?.on('data', (d: Buffer) => this.appendChunk(entry, d.toString('utf8')));
      proc.on('exit', (code) => {
        entry.alive = false;
        entry.exitCode = code;
        this.appendChunk(entry, `\r\n[终端进程已退出，退出码 ${code ?? 0}]\r\n`);
      });
      proc.on('error', (err) => {
        entry.alive = false;
        this.appendChunk(entry, `\r\n[终端启动失败] ${err.message}\r\n`);
      });
    }

    this.sessions.set(id, entry);

    if (params.initialCommand?.trim()) {
      const cmd = params.initialCommand.trim();
      setTimeout(() => {
        if (entry.alive) {
          try {
            this.write(id, cmd + '\r');
          } catch {
            // Ignore if closed early
          }
        }
      }, 350);
    }

    return {
      id: entry.id,
      projectId: entry.projectId,
      title: entry.title,
      kind: entry.kind,
      memberId: entry.memberId,
      alive: entry.alive,
      exitCode: entry.exitCode,
      createdAt: entry.createdAt,
    };
  }

  create(params: {
    projectId: string;
    title?: string;
    initialCommand?: string;
    cols?: number;
    rows?: number;
  }): TerminalTabSummary {
    const project = this.project(params.projectId);
    const existingCount = this.list(project.id).length;
    const title = params.title?.trim() || `PowerShell ${existingCount + 1}`;
    const isWin = process.platform === 'win32';
    return this.spawnInApp({
      projectId: project.id,
      cwd: project.directory,
      title,
      kind: 'shell',
      file: isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash',
      args: isWin ? ['-NoLogo'] : ['-i'],
      cols: params.cols,
      rows: params.rows,
      initialCommand: params.initialCommand,
    });
  }

  write(terminalId: string, data: string): { ok: true } {
    const s = this.sessions.get(terminalId);
    if (!s || !s.alive) {
      throw new Error('该终端已结束，请新建终端标签。');
    }
    if (s.pty) {
      s.pty.write(data);
    } else if (s.proc?.stdin?.writable) {
      s.proc.stdin.write(data);
    }
    return { ok: true };
  }

  resize(terminalId: string, cols: number, rows: number): { ok: true } {
    const s = this.sessions.get(terminalId);
    if (s?.pty && s.alive) {
      try {
        s.pty.resize(Math.max(20, Math.min(300, Math.floor(cols))), Math.max(6, Math.min(120, Math.floor(rows))));
      } catch {
        // Ignore transient resize errors during exit
      }
    }
    return { ok: true };
  }

  interrupt(terminalId: string): { ok: true } {
    const s = this.sessions.get(terminalId);
    if (!s || !s.alive) return { ok: true };
    if (s.pty) {
      s.pty.write('\x03');
    } else {
      try {
        s.proc?.kill('SIGINT');
      } catch {
        // Ignore
      }
    }
    return { ok: true };
  }

  close(terminalId: string): { ok: true } {
    const s = this.sessions.get(terminalId);
    if (s) {
      try {
        s.pty?.kill();
        s.proc?.kill();
      } catch {
        // Ignore
      }
      this.sessions.delete(terminalId);
    }
    return { ok: true };
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
  }

  private async writeHandoffContext(project: Project, roomId: RoomId, memberName: string): Promise<string> {
    const messages = this.host
      .recentRoomMessages(roomId, 18)
      .filter((m) => !m.system && !m.contextOnly && m.text?.trim());
    const relPath = '.fountain/terminal-handoff.md';
    const absPath = path.join(project.directory, '.fountain', 'terminal-handoff.md');
    await mkdir(path.dirname(absPath), { recursive: true });

    const lines: string[] = [
      `# FountAIn 会议室上下文交接（给 ${memberName}）`,
      '',
      `- 项目：${project.name}`,
      `- 目录：${project.directory}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '',
      '## 最近会议室对话',
      '',
    ];

    if (!messages.length) {
      lines.push('（当前会议室暂无聊天记录）');
    } else {
      for (const m of messages) {
        const who = m.author === 'user' ? '用户' : m.authorName || m.author;
        const body = m.text.trim().slice(0, 1200);
        lines.push(`### ${who}`);
        lines.push(body);
        lines.push('');
      }
    }

    for (const candidate of ['01_Drafts_and_Code/sdd/spec.md', '.fountain/sdd/spec.md']) {
      const p = path.join(project.directory, candidate);
      if (existsSync(p)) {
        try {
          const spec = (await readFile(p, 'utf8')).trim().slice(0, 2000);
          if (spec) lines.push('## 当前 SDD Spec 摘要', '', spec, '');
        } catch {
          // Ignore
        }
        break;
      }
    }

    await writeFile(absPath, lines.join('\n'), 'utf8');

    const gitignore = path.join(project.directory, '.gitignore');
    if (existsSync(gitignore)) {
      try {
        const current = await readFile(gitignore, 'utf8');
        if (!current.includes('.fountain/terminal-handoff.md')) {
          await writeFile(
            gitignore,
            `${current.replace(/\s*$/, '')}\n.fountain/terminal-handoff.md\n`,
            'utf8',
          );
        }
      } catch {
        // Ignore
      }
    }
    return relPath;
  }

  private resolveMemberExecutable(
    member: MemberProfile,
    handoffFile?: string,
  ): { file: string; args: string[]; displayCommand: string; env: Record<string, string> } {
    const provider = this.store.get<ProviderInfo>('providers', member.executor);
    const settings = this.store.get<Settings>('settings', 'settings');
    const configuredPath =
      provider?.path ||
      (settings?.paths as Record<string, string | undefined> | undefined)?.[member.executor] ||
      '';
    const nodeExe = this.host.resolveNodeExecutable();
    const env = this.host.resolveMemberEnv(member);
    const handoffPrompt = handoffFile
      ? `请先阅读 ${handoffFile} 了解我们刚才在 FountAIn 会议室的讨论上下文，然后继续协助我。`
      : '';

    const isJs = /\.(?:m?js|cjs)$/i.test(configuredPath);
    const baseFile = configuredPath ? (isJs ? nodeExe : configuredPath) : '';
    const baseArgs = configuredPath && isJs ? [configuredPath] : [];

    if (!baseFile) {
      const isWin = process.platform === 'win32';
      return {
        file: isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash',
        args: isWin ? ['-NoLogo'] : ['-i'],
        displayCommand: 'powershell.exe',
        env,
      };
    }

    let extraArgs: string[] = [];
    if (member.executor === 'claude' || /claude/i.test(configuredPath)) {
      extraArgs = handoffPrompt ? [handoffPrompt] : [];
    } else if (member.executor === 'codex' || /codex/i.test(configuredPath)) {
      extraArgs = handoffPrompt ? [handoffPrompt] : [];
    } else if (member.executor === 'dsh' || /dsh/i.test(configuredPath)) {
      extraArgs = [];
    } else if (/agy(?:\.exe)?$/i.test(configuredPath)) {
      extraArgs = handoffPrompt ? ['-i', handoffPrompt] : [];
    } else {
      extraArgs = handoffPrompt ? [handoffPrompt] : [];
    }

    const args = [...baseArgs, ...extraArgs];
    return {
      file: baseFile,
      args,
      displayCommand: [baseFile, ...args].join(' '),
      env,
    };
  }

  /** Orca-style member terminal launcher: runs natively INSIDE FountAIn via ConPTY by default, or externally if requested. */
  async launchMemberTerminal(params: {
    projectId: string;
    roomId: RoomId;
    memberId: string;
    inheritContext?: boolean;
    external?: boolean;
    cols?: number;
    rows?: number;
  }): Promise<MemberTerminalLaunchResult> {
    const project = this.project(params.projectId);
    const isShell = params.memberId === 'shell';
    const member = isShell
      ? undefined
      : this.store.members().find((m) => m.id === params.memberId);
    if (!isShell && !member) throw new Error('找不到该成员。');

    const title = isShell
      ? `Shell ${this.list(project.id).length + 1}`
      : `${member!.name}${params.inheritContext ? ' · 续聊' : ''}`;

    let handoffFile: string | undefined;
    if (params.inheritContext && member) {
      handoffFile = await this.writeHandoffContext(project, params.roomId, member.name);
    }

    // Default: embedded ConPTY inside FountAIn!
    if (!params.external) {
      if (isShell) {
        const tab = this.create({
          projectId: project.id,
          title,
          cols: params.cols,
          rows: params.rows,
        });
        return {
          launched: true,
          title: tab.title,
          command: 'powershell.exe',
          mode: 'in-app',
          terminalId: tab.id,
        };
      }
      const spec = this.resolveMemberExecutable(member!, handoffFile);
      const tab = this.spawnInApp({
        projectId: project.id,
        cwd: project.directory,
        title,
        kind: 'member',
        memberId: member!.id,
        file: spec.file,
        args: spec.args,
        env: spec.env,
        cols: params.cols,
        rows: params.rows,
      });
      return {
        launched: true,
        title: tab.title,
        command: spec.displayCommand,
        handoffFile,
        mode: 'in-app',
        terminalId: tab.id,
      };
    }

    // Optional external Windows Terminal pop-out
    const spec = isShell
      ? { file: 'powershell.exe', args: ['-NoLogo'], displayCommand: 'powershell.exe', env: {} }
      : this.resolveMemberExecutable(member!, handoffFile);
    if (process.platform === 'win32') {
      const envLines = Object.entries(spec.env).map(([k, v]) => `$env:${k} = ${psSingleQuote(v)}`);
      const runLine = isShell
        ? `Write-Host ${psSingleQuote(`FountAIn · ${project.name}`)} -ForegroundColor Cyan`
        : `& ${psSingleQuote(spec.file)} ${spec.args.map(psSingleQuote).join(' ')}`;
      const launcherFile = path.join(os.tmpdir(), `fountain-term-${randomUUID()}.ps1`);
      const fullScript = [
        'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        ...envLines,
        runLine,
      ].join('\r\n');
      await writeFile(launcherFile, '\uFEFF' + fullScript, { encoding: 'utf8', mode: 0o600 });

      const wtSpawned = await new Promise<boolean>((resolve) => {
        const child = spawn(
          'wt.exe',
          [
            '-w',
            '0',
            'new-tab',
            '--title',
            `FountAIn · ${title}`,
            '-d',
            project.directory,
            'powershell.exe',
            '-NoLogo',
            '-NoExit',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            launcherFile,
          ],
          { detached: true, stdio: 'ignore', windowsHide: false },
        );
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      });
      return {
        launched: true,
        title,
        command: spec.displayCommand,
        handoffFile,
        mode: wtSpawned ? 'windows-terminal' : 'native-console',
      };
    }
    const tab = this.create({ projectId: project.id, title });
    return { launched: true, title: tab.title, command: spec.displayCommand, handoffFile, mode: 'in-app', terminalId: tab.id };
  }
}
