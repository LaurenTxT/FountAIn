import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  FileDiff,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
  Trophy,
  XCircle,
} from 'lucide-react';
import type { Project, Snapshot } from '../shared/types';
import type { FanoutState } from '../shared/workspace-tools';
import { Avatar, useTeam } from './members';
import { Markdown } from './Markdown';
import { Modal } from './modals';
import { runnable, type Invoke } from './ui';

export function FanoutModal({
  project,
  snapshot,
  roster,
  invoke,
  onClose,
  onAdopted,
}: {
  project: Project;
  snapshot: Snapshot;
  roster: string[];
  invoke: Invoke;
  onClose: () => void;
  onAdopted?: () => void;
}) {
  const team = useTeam();
  const readyMembers = useMemo(
    () =>
      team.members.filter(
        (m) =>
          (roster.includes(m.id) || !roster.length) &&
          runnable(snapshot.providers.find((p) => p.id === m.executor)),
      ),
    [team.members, roster, snapshot.providers],
  );

  const [state, setState] = useState<FanoutState | null>(null);
  const [selected, setSelected] = useState<string[]>(() => readyMembers.slice(0, 2).map((m) => m.id));
  const [prompt, setPrompt] = useState('');
  const [activeMember, setActiveMember] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await invoke<FanoutState | null>('project.fanout.get', { projectId: project.id });
      setState(res);
      if (res?.candidates.length && !activeMember) {
        setActiveMember(res.candidates[0].memberId);
      }
    } catch {
      // Ignore initial load error
    }
  }, [invoke, project.id, activeMember]);

  useEffect(() => {
    void load();
  }, [load, snapshot.runs.length]);

  useEffect(() => {
    if (state?.status !== 'running') return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [state?.status, load]);

  function toggleMember(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 3 ? [...prev, id] : prev,
    );
  }

  async function start() {
    if (busy || selected.length < 2 || !prompt.trim()) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<FanoutState>('project.fanout.start', {
        projectId: project.id,
        prompt: prompt.trim(),
        memberIds: selected,
      });
      setState(next);
      setActiveMember(next.candidates[0]?.memberId ?? '');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function adopt(memberId: string) {
    if (busy) return;
    const name = team.get(memberId)?.name ?? memberId;
    if (!window.confirm(`采纳「${name}」的实现并写回项目？（写回前会自动创建 T3 安全检查点）`)) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<FanoutState>(
        'project.fanout.adopt',
        { projectId: project.id, memberId },
        `已采纳 ${name} 的版本并写回项目。`,
      );
      setState(next);
      onAdopted?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await invoke('project.fanout.reset', { projectId: project.id });
      setState(null);
      setActiveMember('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const currentCandidate =
    state?.candidates.find((c) => c.memberId === activeMember) ?? state?.candidates[0];

  return (
    <Modal
      title="同题并行盲写比稿 (Orca Fan-out)"
      subtitle="让 2–3 位成员在各自独立副本里同时写代码，横向对比 Diff 后一键采纳胜出版本。"
      className="fanout-modal-dialog"
      onClose={onClose}
    >
      <div className="modal-body fanout-body">
        {error && (
          <p className="inline-notice error" role="alert">
            {error}
          </p>
        )}

        {!state ? (
          <div className="fanout-setup">
            <label className="fanout-field">
              <span>选择参赛成员（2–3 位）</span>
              <div className="fanout-member-picks">
                {readyMembers.map((m) => {
                  const on = selected.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`fanout-member-chip ${on ? 'selected' : ''}`}
                      onClick={() => toggleMember(m.id)}
                    >
                      <Avatar member={m} size={22} ring={false} />
                      <span>{m.name}</span>
                      {on && <Check size={13} />}
                    </button>
                  );
                })}
              </div>
            </label>
            <label className="fanout-field">
              <span>开发任务要求</span>
              <textarea
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如：重构登录表单校验逻辑，补齐单元测试，保持现有 API 兼容…"
              />
            </label>
          </div>
        ) : (
          <div className="fanout-compare">
            <div className="fanout-prompt-banner">
              <Sparkles size={14} />
              <span>{state.prompt}</span>
            </div>

            <div className="fanout-tabs" role="tablist">
              {state.candidates.map((c) => {
                const m = team.get(c.memberId);
                const isWinner = state.adoptedMemberId === c.memberId;
                return (
                  <button
                    key={c.memberId}
                    type="button"
                    role="tab"
                    aria-selected={currentCandidate?.memberId === c.memberId}
                    className={`fanout-tab ${currentCandidate?.memberId === c.memberId ? 'active' : ''} ${isWinner ? 'winner' : ''}`}
                    onClick={() => setActiveMember(c.memberId)}
                  >
                    {m && <Avatar member={m} size={20} ring={false} />}
                    <strong>{m?.name ?? c.memberId}</strong>
                    {c.status === 'running' ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : c.status === 'completed' ? (
                      <CheckCircle2 size={13} className="ok" />
                    ) : (
                      <XCircle size={13} className="bad" />
                    )}
                    {c.status === 'completed' && (
                      <span className="wt-file-stat">
                        <em className="add">+{c.addedLines}</em>
                        <em className="del">-{c.deletedLines}</em>
                      </span>
                    )}
                    {isWinner && <Trophy size={13} className="trophy" />}
                  </button>
                );
              })}
            </div>

            {currentCandidate && (
              <div className="fanout-candidate-view">
                <div className="fanout-candidate-head">
                  <div className="fanout-candidate-meta">
                    <FileDiff size={14} />
                    <span>
                      {currentCandidate.status === 'running'
                        ? '正在独立副本中编写代码…'
                        : `改动 ${currentCandidate.changedFiles.length} 个文件（+${currentCandidate.addedLines} / -${currentCandidate.deletedLines}）`}
                    </span>
                  </div>
                  {currentCandidate.status === 'completed' && currentCandidate.sessionId && (
                    <button
                      type="button"
                      className="button small primary"
                      disabled={busy || state.adoptedMemberId === currentCandidate.memberId}
                      onClick={() => void adopt(currentCandidate.memberId)}
                    >
                      <Trophy size={13} />
                      {state.adoptedMemberId === currentCandidate.memberId
                        ? '已采纳并写回'
                        : '采纳此版本写回项目'}
                    </button>
                  )}
                </div>

                {currentCandidate.summary && (
                  <div className="fanout-summary">
                    <Markdown text={currentCandidate.summary} />
                  </div>
                )}

                {currentCandidate.diff ? (
                  <pre className="fanout-diff-pre">{currentCandidate.diff}</pre>
                ) : currentCandidate.status === 'completed' ? (
                  <div className="wt-empty">
                    <strong>该成员未修改文件（仅输出文字说明）</strong>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="modal-footer">
        {state ? (
          <>
            <button type="button" className="button quiet" disabled={busy} onClick={() => void reset()}>
              <RotateCcw size={13} /> 发起新一轮比稿
            </button>
            <button type="button" className="button secondary" onClick={onClose}>
              关闭
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button quiet" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || selected.length < 2 || !prompt.trim()}
              onClick={() => void start()}
            >
              {busy ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}
              启动 {selected.length} 人并行盲写
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
