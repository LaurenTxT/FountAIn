import { useCallback, useEffect, useState } from 'react';
import { BookOpenCheck, Check, FileText, GitCompareArrows, LoaderCircle, RotateCcw, Sparkles } from 'lucide-react';
import type { Project, Snapshot } from '../shared/types';
import { DEFAULT_CONSTITUTION_TEMPLATE, type SddStage, type SddState } from '../shared/sdd';
import type { ReviewLevel } from '../shared/project-flow';
import { Avatar, useTeam } from './members';
import { Markdown } from './Markdown';
import { Modal } from './modals';
import { runnable, type Invoke } from './ui';

const SDD_STEPS: { id: string; label: string; stages: SddStage[] }[] = [
  { id: 'spec', label: '1. Spec 规范', stages: ['idle', 'spec_drafting', 'spec_review'] },
  { id: 'blind', label: '2. 双盲提案', stages: ['blind_proposing', 'synthesizing'] },
  { id: 'plan', label: '3. 对照表拍板', stages: ['plan_review'] },
  { id: 'tasks', label: '4. 拆解开工', stages: ['tasks_ready'] },
];

function stepIndexOf(stage: SddStage): number {
  const idx = SDD_STEPS.findIndex((s) => s.stages.includes(stage));
  return idx >= 0 ? idx : 0;
}

export function SddModal({
  project,
  snapshot,
  roster,
  reviewLevel,
  invoke,
  onClose,
  onLaunched,
}: {
  project: Project;
  snapshot: Snapshot;
  roster: string[];
  reviewLevel: ReviewLevel;
  invoke: Invoke;
  onClose: () => void;
  onLaunched: () => void;
}) {
  const team = useTeam();
  const [state, setState] = useState<SddState | null>(null);
  const [requirement, setRequirement] = useState('');
  const [leadId, setLeadId] = useState('');
  const [advisorId, setAdvisorId] = useState('');
  const [specDraft, setSpecDraft] = useState('');
  const [editingSpec, setEditingSpec] = useState(false);
  const [constDraft, setConstDraft] = useState('');
  const [planDraft, setPlanDraft] = useState('');
  const [editingPlan, setEditingPlan] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const [docTab, setDocTab] = useState<'workflow' | 'constitution' | 'spec' | 'plan' | 'tasks'>('workflow');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const readyMembers = team.members.filter((m) =>
    runnable(snapshot.providers.find((p) => p.id === m.executor)),
  );
  const availableMembers = readyMembers.length ? readyMembers : team.members;

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<SddState>('sdd.get', { projectId: project.id });
      setState(next);
      setRequirement((prev) => prev || next.requirement || '');
      setLeadId((prev) => prev || next.leadMemberId || availableMembers[0]?.id || '');
      setAdvisorId((prev) => (prev !== '' ? prev : (next.advisorMemberId ?? '')));
      if (next.specText && !editingSpec) setSpecDraft(next.specText);
      if (next.constitutionText !== undefined) setConstDraft((prev) => prev || next.constitutionText || '');
      if (next.planText && !editingPlan) setPlanDraft(next.planText);
      if (next.error) setError(next.error);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [invoke, project.id, availableMembers, editingSpec, editingPlan]);

  useEffect(() => {
    void refresh();
  }, [project.id]);

  // Poll cleanly while an async SDD phase (spec_drafting / blind_proposing / synthesizing) is running.
  const isRunning = Boolean(
    state && ['spec_drafting', 'blind_proposing', 'synthesizing'].includes(state.stage),
  );
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 1800);
    return () => window.clearInterval(timer);
  }, [isRunning, refresh]);

  async function draftSpec() {
    if (!requirement.trim() || !leadId) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<SddState>('sdd.spec.draft', {
        projectId: project.id,
        requirement,
        leadMemberId: leadId,
        advisorMemberId: advisorId || undefined,
      });
      setState(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveConstitution() {
    if (!constDraft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<SddState>('sdd.constitution.save', {
        projectId: project.id,
        constitutionText: constDraft,
      }, '已保存 constitution.md（后续每轮 SDD 自动带入）');
      setState(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSpec() {
    if (!specDraft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<SddState>('sdd.spec.save', {
        projectId: project.id,
        specText: specDraft,
      }, '已保存 spec.md');
      setState(next);
      setEditingSpec(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startBlind() {
    if (!leadId) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<SddState>('sdd.blind.start', {
        projectId: project.id,
        requirement: requirement.trim() || state?.requirement,
        leadMemberId: leadId,
        advisorMemberId: advisorId && advisorId !== leadId ? advisorId : undefined,
        specText: (editingSpec ? specDraft : state?.specText) || undefined,
      });
      setState(next);
      setEditingSpec(false);
      setDocTab('workflow');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function savePlan() {
    if (!planDraft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<SddState>('sdd.plan.save', {
        projectId: project.id,
        planText: planDraft,
      }, '已保存 plan.md');
      setState(next);
      setEditingPlan(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function approveAndLaunch() {
    setBusy(true);
    setError('');
    try {
      if (editingPlan && planDraft.trim()) {
        await invoke('sdd.plan.save', { projectId: project.id, planText: planDraft });
        setEditingPlan(false);
      }
      const memberIds = [...new Set([leadId, ...(advisorId ? [advisorId] : []), ...roster])].filter((id) =>
        availableMembers.some((m) => m.id === id),
      );
      await invoke(
        'sdd.approve',
        {
          projectId: project.id,
          userDecisionNote: decisionNote.trim() || undefined,
          memberIds: memberIds.length ? memberIds : [leadId],
          reviewLevel,
        },
        '已拍板并转入项目立项拆解任务！',
      );
      onLaunched();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetFlow() {
    if (!window.confirm('重置当前 SDD 进度？（磁盘上已生成的 spec.md / plan.md 会保留，可随时重起）')) return;
    setBusy(true);
    setError('');
    try {
      const next = await invoke<SddState>('sdd.reset', { projectId: project.id });
      setState(next);
      setEditingSpec(false);
      setEditingPlan(false);
      setDocTab('workflow');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const stage = state?.stage ?? 'idle';
  const currentStep = stepIndexOf(stage);
  const leadMember = team.get(leadId || state?.leadMemberId);
  const advisorMember = team.get(advisorId || state?.advisorMemberId);

  return (
    <Modal
      title="SDD 规范驱动 · 双盲提案立项"
      subtitle={state ? `${project.name} · 文档目录：${state.sddRelDir}/` : project.name}
      className="sdd-modal-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="modal-body sdd-modal">
        <div className="sdd-header-bar">
          <ol className="sdd-stepper" aria-label="SDD 阶段进度">
            {SDD_STEPS.map((s, idx) => (
              <li
                key={s.id}
                className={idx < currentStep ? 'done' : idx === currentStep ? 'current' : ''}
              >
                <span className="sdd-step-dot">{idx < currentStep ? <Check size={11} /> : idx + 1}</span>
                <span>{s.label}</span>
              </li>
            ))}
          </ol>
          <div className="sdd-doc-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={docTab === 'workflow'} className={docTab === 'workflow' ? 'active' : ''} onClick={() => setDocTab('workflow')}>
              <GitCompareArrows size={13} />流程
            </button>
            <button type="button" role="tab" aria-selected={docTab === 'constitution'} className={docTab === 'constitution' ? 'active' : ''} onClick={() => { if (!constDraft) setConstDraft(state?.constitutionText || DEFAULT_CONSTITUTION_TEMPLATE); setDocTab('constitution'); }}>
              <BookOpenCheck size={13} />宪法{state?.constitutionText ? ' ✓' : ''}
            </button>
            {state?.specText && (
              <button type="button" role="tab" aria-selected={docTab === 'spec'} className={docTab === 'spec' ? 'active' : ''} onClick={() => setDocTab('spec')}>
                <FileText size={13} />spec.md{state.specCriteria?.length ? ` (${state.specCriteria.length})` : ''}
              </button>
            )}
            {state?.planText && (
              <button type="button" role="tab" aria-selected={docTab === 'plan'} className={docTab === 'plan' ? 'active' : ''} onClick={() => setDocTab('plan')}>
                <FileText size={13} />plan.md
              </button>
            )}
            {state?.tasksText && (
              <button type="button" role="tab" aria-selected={docTab === 'tasks'} className={docTab === 'tasks' ? 'active' : ''} onClick={() => setDocTab('tasks')}>
                <FileText size={13} />tasks.md
              </button>
            )}
          </div>
        </div>

        {error && <p className="inline-notice error" role="alert">{error}</p>}

        {docTab === 'constitution' ? (
          <div className="sdd-review-section">
            <div className="sdd-section-head">
              <strong>项目技术宪法（{state?.sddRelDir}/constitution.md）</strong>
              <small className="panel-muted">长期红线与技术规范，每轮 SDD 自动带入给主控与军师</small>
            </div>
            <div className="sdd-editor-wrap">
              <textarea rows={13} disabled={busy} value={constDraft} onChange={(e) => setConstDraft(e.target.value)} />
              <div className="sdd-actions-row">
                <button type="button" className="button primary small" disabled={busy || !constDraft.trim()} onClick={() => void saveConstitution()}>保存宪法</button>
                <button type="button" className="button quiet small" disabled={busy} onClick={() => setDocTab('workflow')}>返回流程</button>
              </div>
            </div>
          </div>
        ) : docTab !== 'workflow' ? (
          <div className="sdd-doc-preview">
            <Markdown
              text={
                docTab === 'spec'
                  ? state?.specText ?? ''
                  : docTab === 'plan'
                    ? state?.planText ?? ''
                    : state?.tasksText ?? ''
              }
            />
          </div>
        ) : (
          <>
            {(stage === 'idle' || stage === 'tasks_ready') && (
              <div className="sdd-form">
                {stage === 'tasks_ready' && (
                  <p className="inline-notice">
                    已完成上一轮 SDD 拍板并转入任务拆解（文档保存在 <code>{state?.sddRelDir}/</code>）。你可以直接在下方发起新一轮需求迭代。
                  </p>
                )}
                <div className="sdd-role-row">
                  <label className="field">
                    主控（负责起草 Spec、独立提案、核实合成）
                    <select value={leadId} disabled={busy} onChange={(e) => setLeadId(e.target.value)}>
                      {availableMembers.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}（{m.product}）</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    盲出军师（完全隔离上下文，独立出第二份方案）
                    <select value={advisorId} disabled={busy} onChange={(e) => setAdvisorId(e.target.value)}>
                      <option value="">不选军师（主控单出）</option>
                      {availableMembers
                        .filter((m) => m.id !== leadId)
                        .map((m) => (
                          <option key={m.id} value={m.id}>{m.name}（{m.product}）</option>
                        ))}
                    </select>
                  </label>
                </div>
                <label className="field">
                  你想做什么？（直接说原始需求，不必写成技术文档）
                  <textarea
                    rows={4}
                    disabled={busy}
                    value={requirement}
                    onChange={(e) => setRequirement(e.target.value)}
                    placeholder="例如：给项目会议室增加导出 PDF 报告功能，要求保留图表和目录，不要改动现有 Markdown 导出逻辑…"
                  />
                </label>
                <div className="sdd-actions-row">
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || !requirement.trim() || !leadId}
                    onClick={() => void draftSpec()}
                  >
                    <Sparkles size={14} />先出 Spec 规范（SDD 推荐）
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy || !requirement.trim() || !leadId}
                    onClick={() => void startBlind()}
                  >
                    <GitCompareArrows size={14} />跳过 Spec，直接双盲提案
                  </button>
                </div>
              </div>
            )}

            {stage === 'spec_drafting' && (
              <div className="sdd-running-card">
                <LoaderCircle size={18} className="spin" />
                <div>
                  <strong>{leadMember?.name ?? '主控'} 正在只读查代码并起草 spec.md…</strong>
                  <p className="panel-muted">完成后会在这里展示目标、非目标、约束与可验收标准，等你拍板后再启动双盲提案。</p>
                </div>
              </div>
            )}

            {stage === 'spec_review' && (
              <div className="sdd-review-section">
                <div className="sdd-section-head">
                  <strong>已生成需求规范（{state?.sddRelDir}/spec.md）</strong>
                  <button
                    type="button"
                    className="button small quiet"
                    onClick={() => {
                      if (!editingSpec) setSpecDraft(state?.specText ?? '');
                      setEditingSpec((v) => !v);
                    }}
                  >
                    {editingSpec ? '预览' : '编辑 Spec'}
                  </button>
                </div>
                {editingSpec ? (
                  <div className="sdd-editor-wrap">
                    <textarea rows={12} value={specDraft} onChange={(e) => setSpecDraft(e.target.value)} />
                    <button type="button" className="button small secondary" disabled={busy} onClick={() => void saveSpec()}>保存修改</button>
                  </div>
                ) : (
                  <div className="sdd-doc-preview">
                    <Markdown text={state?.specText ?? ''} />
                  </div>
                )}
                <div className="sdd-actions-row">
                  <button type="button" className="button primary" disabled={busy || !leadId} onClick={() => void startBlind()}>
                    <GitCompareArrows size={14} />
                    确认 Spec 并启动双盲提案（{leadMember?.name}{advisorMember ? ` + ${advisorMember.name}` : ''}）
                  </button>
                </div>
              </div>
            )}

            {(stage === 'blind_proposing' || stage === 'synthesizing') && (
              <div className="sdd-blind-progress">
                <div className="sdd-slot-grid">
                  {state?.leadProposal && (
                    <div className={`sdd-slot status-${state.leadProposal.status}`}>
                      <div className="sdd-slot-head">
                        {leadMember && <Avatar member={leadMember} size={24} ring={false} />}
                        <strong>主控 · {state.leadProposal.memberName}</strong>
                        <span className="sdd-slot-badge">
                          {state.leadProposal.status === 'running' ? <><LoaderCircle size={12} className="spin" /> 独立提案中…</> : state.leadProposal.status === 'done' ? '✓ 已完成' : '失败'}
                        </span>
                      </div>
                      <small>隔离只读会话，仅基于你的原话与 Spec 独立思考</small>
                    </div>
                  )}
                  {state?.advisorProposal && (
                    <div className={`sdd-slot status-${state.advisorProposal.status}`}>
                      <div className="sdd-slot-head">
                        {advisorMember && <Avatar member={advisorMember} size={24} ring={false} />}
                        <strong>军师 · {state.advisorProposal.memberName}</strong>
                        <span className="sdd-slot-badge">
                          {state.advisorProposal.status === 'running' ? <><LoaderCircle size={12} className="spin" /> 独立盲出中…</> : state.advisorProposal.status === 'done' ? '✓ 已完成' : '失败'}
                        </span>
                      </div>
                      <small>完全看不到主控草稿，未核实项会标注【推测】</small>
                    </div>
                  )}
                </div>
                {stage === 'synthesizing' && (
                  <div className="sdd-running-card">
                    <LoaderCircle size={18} className="spin" />
                    <div>
                      <strong>{leadMember?.name ?? '主控'} 正在核实军师的【推测】项并合成《双盲方案对照表》…</strong>
                      <p className="panel-muted">完成后会分 4 块展示：一致项、采纳项、未采纳理由、待你拍板的分歧。</p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {stage === 'plan_review' && (
              <div className="sdd-review-section">
                <div className="sdd-section-head">
                  <strong>双盲方案对照表与实施方案（{state?.sddRelDir}/plan.md）</strong>
                  <button
                    type="button"
                    className="button small quiet"
                    onClick={() => {
                      if (!editingPlan) setPlanDraft(state?.planText ?? '');
                      setEditingPlan((v) => !v);
                    }}
                  >
                    {editingPlan ? '预览' : '编辑方案'}
                  </button>
                </div>
                {editingPlan ? (
                  <div className="sdd-editor-wrap">
                    <textarea rows={14} value={planDraft} onChange={(e) => setPlanDraft(e.target.value)} />
                    <button type="button" className="button small secondary" disabled={busy} onClick={() => void savePlan()}>保存修改</button>
                  </div>
                ) : (
                  <div className="sdd-doc-preview">
                    <Markdown text={state?.planText ?? ''} />
                  </div>
                )}

                {(state?.leadProposal?.text || state?.advisorProposal?.text) && (
                  <details className="sdd-raw-proposals">
                    <summary>查看双方原始盲出方案（防信息丢失）</summary>
                    <div className="sdd-raw-grid">
                      {state.leadProposal?.text && (
                        <div className="sdd-raw-pane">
                          <h4>主控 · {state.leadProposal.memberName} 原稿</h4>
                          <Markdown text={state.leadProposal.text} />
                        </div>
                      )}
                      {state.advisorProposal?.text && (
                        <div className="sdd-raw-pane">
                          <h4>军师 · {state.advisorProposal.memberName} 原稿</h4>
                          <Markdown text={state.advisorProposal.text} />
                        </div>
                      )}
                    </div>
                  </details>
                )}

                <label className="field">
                  你的拍板意见（可选，如对分歧项的选择或补充要求）
                  <textarea
                    rows={2}
                    disabled={busy}
                    value={decisionNote}
                    onChange={(e) => setDecisionNote(e.target.value)}
                    placeholder="例如：分歧 1 选推荐项，其他按方案直接拆任务开工"
                  />
                </label>
              </div>
            )}
          </>
        )}
      </div>

      <div className="modal-footer sdd-footer">
        <div className="sdd-footer-left">
          {stage !== 'idle' && !isRunning && (
            <button type="button" className="button small quiet" disabled={busy} onClick={() => void resetFlow()}>
              <RotateCcw size={13} />重新开始
            </button>
          )}
        </div>
        <div className="sdd-footer-right">
          <button type="button" className="button quiet" disabled={busy} onClick={onClose}>
            {isRunning ? '后台继续跑' : '关闭'}
          </button>
          {stage === 'plan_review' && (
            <button type="button" className="button primary" disabled={busy} onClick={() => void approveAndLaunch()}>
              <Check size={14} />拍板并拆解任务开工
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
