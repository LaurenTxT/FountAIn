import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  History,
  LoaderCircle,
  Play,
  Plus,
  Send,
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
}: {
  project: Project;
  roomId: RoomId;
  roster: string[];
  invoke: Invoke;
}) {
  const team = useTeam();
  const [tabs, setTabs] = useState<TerminalTabSummary[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [snapshot, setSnapshot] = useState<TerminalOutputSnapshot | null>(null);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [plusOpen, setPlusOpen] = useState(false);
  const [scripts, setScripts] = useState<ProjectScriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [sendingError, setSendingError] = useState(false);
  const [notice, setNotice] = useState('');
  const outRef = useRef<HTMLPreElement>(null);

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
    setSnapshot(null);
    setActiveId('');
    setNotice('');
    void loadTabs();
    void loadScripts();
  }, [project.id, loadTabs, loadScripts]);

  // Poll active terminal output smoothly
  useEffect(() => {
    if (!activeId) {
      setSnapshot(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const snap = await invoke<TerminalOutputSnapshot>('project.terminal.read', {
          projectId: project.id,
          terminalId: activeId,
        });
        if (alive) {
          setSnapshot((prev) => {
            if (prev?.id === snap.id && prev.seq === snap.seq) return prev;
            return snap;
          });
        }
      } catch {
        // Tab may have been closed
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 700);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [activeId, invoke, project.id]);

  // Auto-scroll to bottom on new output
  useEffect(() => {
    const node = outRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [snapshot?.seq]);

  async function createShellTab(initialCommand?: string, title?: string) {
    setBusy(true);
    setPlusOpen(false);
    try {
      const created = await invoke<TerminalTabSummary>('project.terminal.create', {
        projectId: project.id,
        title,
        initialCommand,
      });
      await loadTabs();
      setActiveId(created.id);
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function launchMember(memberId: string, inheritContext: boolean) {
    setBusy(true);
    setPlusOpen(false);
    try {
      const res = await invoke<MemberTerminalLaunchResult>(
        'project.terminal.launchMember',
        { projectId: project.id, roomId, memberId, inheritContext },
        inheritContext
          ? '已导出当前聊天上下文并拉起成员交互终端。'
          : '已拉起新的交互终端窗口。',
      );
      setNotice(
        res.handoffFile
          ? `已打开「${res.title}」· 上下文已同步到 ${res.handoffFile}`
          : `已打开「${res.title}」`,
      );
      if (res.mode === 'in-app') {
        await loadTabs();
      }
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendCommand() {
    const cmd = input.trim();
    if (!cmd) return;
    setInput('');
    setHistory((prev) => [cmd, ...prev.filter((x) => x !== cmd)].slice(0, 40));
    setHistIdx(-1);

    if (!activeId) {
      await createShellTab(cmd);
      return;
    }
    try {
      await invoke('project.terminal.write', { projectId: project.id, terminalId: activeId, command: cmd });
    } catch (err) {
      setNotice((err as Error).message);
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
        command: sc.command,
      });
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
    } catch {
      // Ignore
    }
  }

  async function sendTerminalTailToAgent() {
    if (!snapshot?.output || sendingError) return;
    setSendingError(true);
    try {
      const tail = snapshot.output.trim().slice(-2600);
      const codex = team.members.find((m) => m.id === 'codex' && roster.includes(m.id));
      const mention = codex ? `@${codex.name} ` : '';
      const text = `${mention}我在项目终端里运行命令遇到以下输出/报错，请帮我分析原因并处理：\n\n\`\`\`\n${tail}\n\`\`\``;
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
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeId}
              className={`wt-term-tab ${tab.id === activeId ? 'active' : ''}`}
            >
              <button type="button" className="wt-term-tab-btn" onClick={() => setActiveId(tab.id)}>
                <span className={`wt-term-dot ${tab.alive ? 'alive' : 'dead'}`} />
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
          ))}
        </div>
        <div className="wt-term-plus-wrap">
          <button
            type="button"
            className={`wt-term-plus ${plusOpen ? 'open' : ''}`}
            title="新建终端或拉起成员模型交互终端"
            aria-expanded={plusOpen}
            disabled={busy}
            onClick={() => setPlusOpen((v) => !v)}
          >
            {busy ? <LoaderCircle size={13} className="spin" /> : <Plus size={14} />}
            <span>新建</span>
          </button>
        </div>
      </div>

      {/* Orca "+" Popover Menu: Pick Member Model CLI (Fresh / Inherit Chat) or Shell */}
      {plusOpen && (
        <div className="wt-term-menu" role="menu">
          <div className="wt-term-menu-section">
            <span className="wt-term-menu-label">拉起成员交互终端（Windows Terminal）</span>
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
                    title={`全新打开 ${m.name} 交互终端`}
                    onClick={() => void launchMember(m.id, false)}
                  >
                    <ExternalLink size={11} /> 全新
                  </button>
                  <button
                    type="button"
                    className="button small secondary"
                    title={`导出当前聊天上下文并打开 ${m.name} 终端`}
                    onClick={() => void launchMember(m.id, true)}
                  >
                    <History size={11} /> 继承聊天
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="wt-term-menu-section">
            <span className="wt-term-menu-label">系统 Shell 终端</span>
            <div className="wt-term-shell-btns">
              <button type="button" className="button small secondary" onClick={() => void createShellTab()}>
                <Terminal size={12} /> 内置 PowerShell 标签
              </button>
              <button type="button" className="button small quiet" onClick={() => void launchMember('shell', false)}>
                <ExternalLink size={12} /> 弹出系统终端窗口
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Script Pills (merged from Code panel so zero duplication) */}
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

      {/* Terminal Screen or Orca Empty Launcher */}
      {!activeId ? (
        <div className="wt-term-empty">
          <Terminal size={24} />
          <strong>项目交互终端</strong>
          <small>点右上角「+ 新建」拉起任意成员的真实 CLI 终端（支持全新对话或继承当前聊天上下文），或直接开启内置 PowerShell。</small>
          <div className="wt-term-empty-actions">
            <button type="button" className="button small primary" onClick={() => void createShellTab()}>
              <Plus size={13} /> 开启内置终端
            </button>
            <button type="button" className="button small secondary" onClick={() => setPlusOpen(true)}>
              <Sparkles size={13} /> 选择成员模型终端
            </button>
          </div>
        </div>
      ) : (
        <>
          <pre ref={outRef} className="wt-term-output">
            {snapshot?.output || '正在初始化终端…'}
          </pre>
          <div className="wt-term-input-bar">
            <span className="wt-term-prompt">&gt;</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入命令后回车运行（↑/↓ 翻历史）…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void sendCommand();
                } else if (e.key === 'ArrowUp' && history.length) {
                  e.preventDefault();
                  const next = Math.min(histIdx + 1, history.length - 1);
                  setHistIdx(next);
                  setInput(history[next]);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  const next = histIdx - 1;
                  setHistIdx(next);
                  setInput(next >= 0 ? history[next] : '');
                } else if (e.key === 'c' && e.ctrlKey && !input) {
                  e.preventDefault();
                  void interruptActive();
                }
              }}
            />
            <button
              type="button"
              className="icon-button"
              title="发送中断 (Ctrl+C)"
              onClick={() => void interruptActive()}
            >
              <Square size={12} />
            </button>
            <button
              type="button"
              className="button small quiet"
              title="把当前终端输出/报错发给会议室成员排查"
              disabled={sendingError || !snapshot?.output}
              onClick={() => void sendTerminalTailToAgent()}
            >
              {sendingError ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
              发给成员
            </button>
            <button
              type="button"
              className="button small primary"
              disabled={!input.trim()}
              onClick={() => void sendCommand()}
            >
              <Send size={12} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
