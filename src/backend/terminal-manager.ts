import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MemberProfile, Project, ProviderInfo, RoomId, RoomMessage, Settings } from '../shared/types';
import type {
  MemberTerminalLaunchResult,
  TerminalOutputSnapshot,
  TerminalTabSummary,
} from '../shared/workspace-tools';
import type { Store } from './store';

const MAX_BUFFER_CHARS = 120_000;

// Strip ANSI escape sequences for clean in-app terminal rendering
function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07/g, '');
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
  proc: ChildProcess;
  output: string;
  seq: number;
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

  read(terminalId: string): TerminalOutputSnapshot {
    const s = this.sessions.get(terminalId);
    if (!s) throw new Error('终端会话不存在或已关闭。');
    return {
      id: s.id,
      projectId: s.projectId,
      title: s.title,
      kind: s.kind,
      memberId: s.memberId,
      alive: s.alive,
      exitCode: s.exitCode,
      createdAt: s.createdAt,
      output: s.output,
      seq: s.seq,
    };
  }

  create(params: { projectId: string; title?: string; initialCommand?: string }): TerminalTabSummary {
    const project = this.project(params.projectId);
    const id = `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const existingCount = this.list(project.id).length;
    const title = params.title?.trim() || `PowerShell ${existingCount + 1}`;
    const isWin = process.platform === 'win32';

    const proc = isWin
      ? spawn(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NoExit',
            '-Command',
            '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8',
          ],
          {
            cwd: project.directory,
            windowsHide: true,
            env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb' },
          },
        )
      : spawn(process.env.SHELL || '/bin/bash', ['-i'], {
          cwd: project.directory,
          env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb' },
        });

    const entry: LiveTerminal = {
      id,
      projectId: project.id,
      title,
      kind: 'shell',
      proc,
      output: `[FountAIn 终端] 工作目录: ${project.directory}\n`,
      seq: 1,
      alive: true,
      exitCode: null,
      createdAt: new Date().toISOString(),
    };

    const append = (chunk: Buffer | string) => {
      const text = stripAnsi(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      if (!text) return;
      entry.output = (entry.output + text).slice(-MAX_BUFFER_CHARS);
      entry.seq += 1;
    };

    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('exit', (code) => {
      entry.alive = false;
      entry.exitCode = code;
      append(`\n[进程已退出，退出码 ${code ?? 0}]\n`);
    });
    proc.on('error', (err) => {
      entry.alive = false;
      append(`\n[终端启动失败] ${err.message}\n`);
    });

    this.sessions.set(id, entry);

    if (params.initialCommand?.trim()) {
      this.write(id, params.initialCommand.trim());
    }

    return {
      id: entry.id,
      projectId: entry.projectId,
      title: entry.title,
      kind: entry.kind,
      alive: entry.alive,
      exitCode: entry.exitCode,
      createdAt: entry.createdAt,
    };
  }

  write(terminalId: string, command: string): { ok: true } {
    const s = this.sessions.get(terminalId);
    if (!s || !s.alive || !s.proc.stdin?.writable) {
      throw new Error('该终端已结束，请新建终端标签。');
    }
    const line = command.replace(/\r?\n$/, '');
    s.output = (s.output + `\n> ${line}\n`).slice(-MAX_BUFFER_CHARS);
    s.seq += 1;
    s.proc.stdin.write(line + (process.platform === 'win32' ? '\r\n' : '\n'));
    return { ok: true };
  }

  interrupt(terminalId: string): { ok: true } {
    const s = this.sessions.get(terminalId);
    if (!s) return { ok: true };
    if (s.alive) {
      try {
        s.proc.kill('SIGINT');
      } catch {
        // Fallback
      }
      s.output = (s.output + '\n^C [已发送中断信号]\n').slice(-MAX_BUFFER_CHARS);
      s.seq += 1;
    }
    return { ok: true };
  }

  close(terminalId: string): { ok: true } {
    const s = this.sessions.get(terminalId);
    if (s) {
      try {
        s.proc.kill();
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
    const messages = this.host.recentRoomMessages(roomId, 18).filter((m) => !m.system && !m.contextOnly && m.text?.trim());
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

    // Include SDD spec snippet if present
    for (const candidate of ['01_Drafts_and_Code/sdd/spec.md', '.fountain/sdd/spec.md']) {
      const p = path.join(project.directory, candidate);
      if (existsSync(p)) {
        try {
          const spec = (await readFile(p, 'utf8')).trim().slice(0, 2000);
          if (spec) {
            lines.push('## 当前 SDD Spec 摘要', '', spec, '');
          }
        } catch {
          // Ignore
        }
        break;
      }
    }

    await writeFile(absPath, lines.join('\n'), 'utf8');

    // Keep git clean if .gitignore exists
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

  private resolveMemberLaunchCommand(
    member: MemberProfile,
    handoffFile?: string,
  ): { displayCommand: string; psScript: string } {
    const provider = this.store.get<ProviderInfo>('providers', member.executor);
    const settings = this.store.get<Settings>('settings', 'settings');
    const configuredPath =
      provider?.path ||
      (settings?.paths as Record<string, string | undefined> | undefined)?.[member.executor] ||
      '';
    const nodeExe = this.host.resolveNodeExecutable();
    const memberEnv = this.host.resolveMemberEnv(member);
    const handoffPrompt = handoffFile
      ? `请先阅读 ${handoffFile} 了解我们刚才在 FountAIn 会议室的讨论上下文，然后继续协助我。`
      : '';

    const envLines = Object.entries(memberEnv).map(
      ([k, v]) => `$env:${k} = ${psSingleQuote(v)}`,
    );

    const bannerLines = [
      `Write-Host '================================================' -ForegroundColor DarkCyan`,
      `Write-Host ${psSingleQuote(`  FountAIn · ${member.name} 交互终端`)} -ForegroundColor Cyan`,
      handoffFile
        ? `Write-Host ${psSingleQuote(`  已继承聊天上下文 -> ${handoffFile}`)} -ForegroundColor Green`
        : `Write-Host '  全新独立对话会话（已自动复用 FountAIn 登录状态）' -ForegroundColor DarkGray`,
      `Write-Host '================================================' -ForegroundColor DarkCyan`,
    ];

    // Helper for JS entrypoints vs native exe
    const isJs = /\.(?:m?js|cjs)$/i.test(configuredPath);
    const execExpr = configuredPath
      ? isJs
        ? `& ${psSingleQuote(nodeExe)} ${psSingleQuote(configuredPath)}`
        : `& ${psSingleQuote(configuredPath)}`
      : '';

    let runLine = '';
    if (member.executor === 'claude' || /claude/i.test(configuredPath)) {
      const base = execExpr || 'claude';
      runLine = handoffPrompt ? `${base} ${psSingleQuote(handoffPrompt)}` : base;
    } else if (member.executor === 'codex' || /codex/i.test(configuredPath)) {
      const base = execExpr || 'codex';
      runLine = handoffPrompt ? `${base} ${psSingleQuote(handoffPrompt)}` : base;
    } else if (member.executor === 'dsh' || /dsh/i.test(configuredPath)) {
      const base = execExpr || 'dsh';
      runLine = base;
      if (handoffPrompt) {
        bannerLines.push(
          `Write-Host ${psSingleQuote(`  提示：进入后可输入「${handoffPrompt}」`)} -ForegroundColor Yellow`,
        );
      }
    } else if (/agy(?:\.exe)?$/i.test(configuredPath)) {
      const base = execExpr || 'agy';
      runLine = handoffPrompt ? `${base} -i ${psSingleQuote(handoffPrompt)}` : base;
    } else if (execExpr) {
      runLine = handoffPrompt ? `${execExpr} ${psSingleQuote(handoffPrompt)}` : execExpr;
    } else {
      runLine = `Write-Host ${psSingleQuote(`未检测到 ${member.name} 的本地 CLI 入口，已打开项目 PowerShell 终端。`)} -ForegroundColor Yellow`;
    }

    return {
      displayCommand: runLine,
      psScript: [...envLines, ...bannerLines, runLine].join('\r\n'),
    };
  }

  /** Orca-style member terminal launcher: opens a real interactive terminal for any member (fresh or with inherited room context). */
  async launchMemberTerminal(params: {
    projectId: string;
    roomId: RoomId;
    memberId: string;
    inheritContext?: boolean;
  }): Promise<MemberTerminalLaunchResult> {
    const project = this.project(params.projectId);
    const isShell = params.memberId === 'shell';
    const member = isShell
      ? undefined
      : this.store.members().find((m) => m.id === params.memberId);
    if (!isShell && !member) throw new Error('找不到该成员。');

    const title = isShell
      ? `FountAIn · ${project.name} Shell`
      : `FountAIn · ${member!.name}${params.inheritContext ? '（继承上下文）' : ''}`;

    let handoffFile: string | undefined;
    if (params.inheritContext && member) {
      handoffFile = await this.writeHandoffContext(project, params.roomId, member.name);
    }

    const { displayCommand, psScript } = isShell
      ? {
          displayCommand: 'powershell.exe',
          psScript: `Write-Host ${psSingleQuote(`FountAIn · ${project.name} 项目终端`)} -ForegroundColor Cyan`,
        }
      : this.resolveMemberLaunchCommand(member!, handoffFile);

    if (process.platform === 'win32') {
      // Write a self-deleting temp launcher script (UTF-8 BOM) so:
      // 1) wt.exe -w 0 preserves all FountAIn auth env vars (CLAUDE_CONFIG_DIR, DSH_HOME, CODEX_HOME, API key, proxy)
      // 2) Secrets never appear on the command line or process list
      const launcherFile = path.join(os.tmpdir(), `fountain-term-${randomUUID()}.ps1`);
      const fullScript = [
        'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
        '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '$OutputEncoding = [System.Text.Encoding]::UTF8',
        psScript,
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
            title,
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

      if (wtSpawned) {
        return { launched: true, title, command: displayCommand, handoffFile, mode: 'windows-terminal' };
      }

      // Fallback to classic Windows PowerShell console window
      const fallback = spawn(
        'cmd.exe',
        ['/c', 'start', title, 'powershell.exe', '-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', launcherFile],
        { cwd: project.directory, detached: true, stdio: 'ignore', windowsHide: true },
      );
      fallback.unref();
      return { launched: true, title, command: displayCommand, handoffFile, mode: 'native-console' };
    }

    // Non-Windows fallback: open an in-app terminal tab running the command
    this.create({ projectId: project.id, title, initialCommand: displayCommand });
    return { launched: true, title, command: displayCommand, handoffFile, mode: 'in-app' };
  }
}
