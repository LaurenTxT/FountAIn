import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  ExternalLink,
  History,
  LoaderCircle,
  Play,
  Plus,
  Sparkles,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import type { Project, RoomId } from '../shared/types';
import type {
  MemberTerminalLaunchResult,
  ProjectScriptItem,
  TerminalOutputSnapshot,
  TerminalTabSummary,
} from '../shared/workspace-tools';
import { Avatar, useTeam } from './members';
import type { Invoke } from './ui';

export function WorkspaceTerminalPanel({
  project,
  roomId,
  roster,
  invoke,
  focusTerminalId,
}: {
  project: Project;
  roomId: RoomId;
  roster: string[];
  invoke: Invoke;
  focusTerminalId?: string;
}) {
  const team = useTeam();
  const [tabs, setTabs] = useState<TerminalTabSummary[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [scripts, setScripts] = useState<ProjectScriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [sendingError, setSendingError] = useState(false);
  const [notice, setNotice] = useState('');

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const offsetRef = useRef<number>(0);
  const tailBufferRef = useRef<string>('');

  const loadTabs = useCallback(async () => {
    try {
      const list = await invoke<TerminalTabSummary[]>('project.terminal.list', { projectId: project.id });
      setTabs(list);
      setActiveId((prev) => (prev && list.some((t) => t.id === prev) ? prev : list[0]?.id ?? ''));
    } catch {
      setTabs([]);
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
    setActiveId('');
    setNotice('');
    void loadTabs();
    void loadScripts();
  }, [project.id, loadTabs, loadScripts]);

  useEffect(() => {
    if (!focusTerminalId) return;
    void loadTabs().then(() => setActiveId(focusTerminalId));
  }, [focusTerminalId, loadTabs]);

  // Mount & bind xterm.js to the active PTY terminal tab
  useEffect(() => {
    const container = hostRef.current;
    if (!activeId || !container) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 12.5,
      lineHeight: 1.32,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Microsoft YaHei UI", monospace',
      scrollback: 5000,
      theme: {
        background: '#111319',
        foreground: '#e6eaf5',
        cursor: '#7c8cf8',
        selectionBackground: 'rgba(124, 140, 248, 0.32)',
        black: '#1a1d26',
        red: '#f07c7c',
        green: '#58c996',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#38bdf8',
        white: '#eef0f6',
        brightBlack: '#64748b',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#7dd3fc',
        brightWhite: '#ffffff',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    container.innerHTML = '';
    term.open(container);

    termRef.current = term;
    fitRef.current = fitAddon;
    offsetRef.current = 0;
    tailBufferRef.current = '';

    const syncSize = () => {
      try {
        fitAddon.fit();
        if (term.cols > 0 && term.rows > 0) {
          void invoke('project.terminal.resize', {
            projectId: project.id,
            terminalId: activeId,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        }
      } catch {
        // Ignore transient layout sizing
      }
    };

    window.requestAnimationFrame(() => {
      syncSize();
      term.focus();
    });

    const ro = new ResizeObserver(() => syncSize());
    ro.observe(container);

    // Send live keystrokes straight to ConPTY
    const dataDisp = term.onData((data) => {
      void invoke('project.terminal.write', {
        projectId: project.id,
        terminalId: activeId,
        data,
      }).catch(() => {});
    });

    // High-frequency incremental output stream polling (80ms)
    let alive = true;
    let inFlight = false;
    const poll = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const snap = await invoke<TerminalOutputSnapshot>('project.terminal.read', {
          projectId: project.id,
          terminalId: activeId,
          offset: offsetRef.current,
        });
        if (!alive) return;
        if (snap.reset) term.reset();
        if (snap.data) {
          term.write(snap.data);
          tailBufferRef.current = (tailBufferRef.current + snap.data).slice(-6000);
        }
        offsetRef.current = snap.nextOffset;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === snap.id && (t.alive !== snap.alive || t.exitCode !== snap.exitCode)
              ? { ...t, alive: snap.alive, exitCode: snap.exitCode }
              : t,
          ),
        );
      } catch {
        // Tab closed
      } finally {
        inFlight = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 80);

    return () => {
      alive = false;
      window.clearInterval(timer);
      ro.disconnect();
      dataDisp.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [activeId, invoke, project.id]);

  function currentDims() {
    return {
      cols: termRef.current?.cols || 90,
      rows: termRef.current?.rows || 26,
    };
  }

  async function createShellTab(initialCommand?: string, title?: string) {
    setBusy(true);
    setPlusOpen(false);
    try {
      const { cols, rows } = currentDims();
      const created = await invoke<TerminalTabSummary>('project.terminal.create', {
        projectId: project.id,
        title,
        initialCommand,
        cols,
        rows,
      });
      await loadTabs();
      setActiveId(created.id);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function launchMember(memberId: string, inheritContext: boolean, external = false) {
    setBusy(true);
    setPlusOpen(false);
    try {
      const { cols, rows } = currentDims();
      const res = await invoke<MemberTerminalLaunchResult>(
        'project.terminal.launchMember',
        { projectId: project.id, roomId, memberId, inheritContext, external, cols, rows },
      );
      if (res.handoffFile) {
        setNotice(`已继承聊天上下文 -> ${res.handoffFile}`);
      } else {
        setNotice('');
      }
      if (res.terminalId) {
        await loadTabs();
        setActiveId(res.terminalId);
      }
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runQuickScript(sc: ProjectScriptItem) {
    if (!activeId) {
      await createShellTab(sc.command, sc.name);
      return;
    }
    try {
      await invoke('project.terminal.write', {
        projectId: project.id,
        terminalId: activeId,
        data: sc.command + '\r',
      });
      termRef.current?.focus();
    } catch (err) {
      setNotice((err as Error).message);
    }
  }

  async function closeTab(id: string) {
    try {
      await invoke('project.terminal.close', { projectId: project.id, terminalId: id });
      await loadTabs();
    } catch {
      // Ignore
    }
  }

  async function interruptActive() {
    if (!activeId) return;
    try {
      await invoke('project.terminal.interrupt', { projectId: project.id, terminalId: activeId });
      termRef.current?.focus();
    } catch {
      // Ignore
    }
  }

  async function sendTerminalTailToAgent() {
    const cleanTail = tailBufferRef.current
      .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07/g, '')
      .trim()
      .slice(-2600);
    if (!cleanTail || sendingError) return;
    setSendingError(true);
    try {
      const codex = team.members.find((m) => m.id === 'codex' && roster.includes(m.id));
      const mention = codex ? `@${codex.name} ` : '';
      const text = `${mention}我在内置终端里运行命令遇到以下输出/报错，请帮我分析原因并处理：\n\n\`\`\`\n${cleanTail}\n\`\`\``;
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
        '已把终端输出发到会议室。',
      );
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setSendingError(false);
    }
  }

  const members = team.members.filter((m) => !m.card.cardHidden);

  return (
    <div className="wt-term-panel">
      {/* Orca-style Terminal Tab Strip + "+" Launcher */}
      <div className="wt-term-bar">
        <div className="wt-term-tabs" role="tablist">
          {tabs.map((tab) => {
            const m = tab.memberId ? team.get(tab.memberId) : undefined;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeId}
                className={`wt-term-tab ${tab.id === activeId ? 'active' : ''}`}
              >
                <button type="button" className="wt-term-tab-btn" onClick={() => setActiveId(tab.id)}>
                  {m ? <Avatar member={m} size={15} ring={false} /> : <span className={`wt-term-dot ${tab.alive ? 'alive' : 'dead'}`} />}
                  <span>{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="wt-term-tab-close"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={() => void closeTab(tab.id)}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="wt-term-bar-right">
          {activeId && (
            <>
              <button
                type="button"
                className="icon-button"
                title="中断当前命令 (Ctrl+C)"
                onClick={() => void interruptActive()}
              >
                <Square size={12} />
              </button>
              <button
                type="button"
                className="icon-button"
                title="把终端最近输出/报错发给会议室成员排查"
                disabled={sendingError}
                onClick={() => void sendTerminalTailToAgent()}
              >
                {sendingError ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={13} />}
              </button>
            </>
          )}
          <button
            type="button"
            className={`wt-term-plus ${plusOpen ? 'open' : ''}`}
            title="新建内置终端或成员模型交互终端"
            aria-expanded={plusOpen}
            disabled={busy}
            onClick={() => setPlusOpen((v) => !v)}
          >
            {busy ? <LoaderCircle size={13} className="spin" /> : <Plus size={14} />}
            <span>新建</span>
          </button>
        </div>
      </div>

      {/* Orca "+" Popover Menu: Embedded Member CLIs (Fresh / Inherit Chat) + Shell */}
      {plusOpen && (
        <div className="wt-term-menu" role="menu">
          <div className="wt-term-menu-section">
            <span className="wt-term-menu-label">内置成员交互终端（直接嵌在应用内）</span>
            {members.map((m) => (
              <div key={m.id} className="wt-term-member-row">
                <span className="wt-term-member-info">
                  <Avatar member={m} size={20} ring={false} />
                  <strong>{m.name}</strong>
                  <small>{m.product}</small>
                </span>
                <span className="wt-term-member-btns">
                  <button
                    type="button"
                    className="button small quiet"
                    title={`在应用内新开 ${m.name} 交互终端`}
                    onClick={() => void launchMember(m.id, false, false)}
                  >
                    <Terminal size={11} /> 全新
                  </button>
                  <button
                    type="button"
                    className="button small secondary"
                    title={`导出当前聊天上下文并在应用内打开 ${m.name} 终端`}
                    onClick={() => void launchMember(m.id, true, false)}
                  >
                    <History size={11} /> 继承聊天
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title={`弹出独立 Windows Terminal 窗口运行 ${m.name}`}
                    onClick={() => void launchMember(m.id, false, true)}
                  >
                    <ExternalLink size={11} />
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="wt-term-menu-section">
            <span className="wt-term-menu-label">系统 Shell</span>
            <div className="wt-term-shell-btns">
              <button type="button" className="button small secondary" onClick={() => void createShellTab()}>
                <Terminal size={12} /> 内置 PowerShell
              </button>
              <button type="button" className="button small quiet" onClick={() => void launchMember('shell', false, true)}>
                <ExternalLink size={12} /> 弹出外部窗口
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Script Pills */}
      {scripts.length > 0 && (
        <div className="wt-term-scripts">
          {scripts.slice(0, 7).map((sc) => (
            <button
              key={sc.id}
              type="button"
              className="wt-script-pill"
              title={`在终端运行: ${sc.command}`}
              onClick={() => void runQuickScript(sc)}
            >
              <Play size={10} />
              <span>{sc.name}</span>
            </button>
          ))}
        </div>
      )}

      {notice && (
        <div className="wt-term-notice">
          <span>{notice}</span>
          <button type="button" className="icon-button" onClick={() => setNotice('')}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* Embedded xterm.js Canvas or Empty Launcher */}
      {!activeId ? (
        <div className="wt-term-empty">
          <Terminal size={24} />
          <strong>内置交互终端（ConPTY）</strong>
          <small>支持在应用内直接运行 Claude、Codex、DeepSeek、Gemini 完整彩色交互界面，自动复用 FountAIn 登录状态。</small>
          <div className="wt-term-empty-actions">
            <button type="button" className="button small primary" onClick={() => setPlusOpen(true)}>
              <Plus size={13} /> 选择成员模型终端
            </button>
            <button type="button" className="button small secondary" onClick={() => void createShellTab()}>
              <Terminal size={13} /> 打开 PowerShell
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={hostRef}
          className="wt-xterm-host"
          onClick={() => termRef.current?.focus()}
        />
      )}
    </div>
  );
}
