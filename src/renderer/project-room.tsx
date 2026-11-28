import { MemberSelect } from './member-select';
import {joinClauses,plainFlowError,readableContent} from '../shared/content-presentation';
import { GitBranch, GitCompareArrows, History, LayoutList, Terminal, Wrench } from 'lucide-react';
import { WorkspaceCodePanel } from './workspace-code-panel';
import { WorkspaceTerminalPanel } from './workspace-terminal-panel';
import { FanoutModal } from './fanout-modal';
import './workspace-tools.css';
import {workspaceLocation} from './workspace-location';
import { memberUserSummary, reportForDisplay } from '../shared/report-presentation';
import { RoundResults } from './round-results';
import {WORKBENCH_READS} from '../shared/project-workbench';
import {PROGRESS_READS} from '../shared/project-progress';
import {ProjectProgressView} from './project-progress';
import './project-progress.css';
import {TaskAdditionView} from './task-addition';
import type {TaskAddition} from '../shared/project-workbench';
import { WorkLog } from './work-log';
import { FlowRunStop } from './flow-run-stop';
import { LOG_READS, type LogTarget } from '../shared/work-log';
import { RESULT_READS } from '../shared/round-results';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, AppWindow, ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronRight, ChevronsDown, ChevronUp, FileDiff, FolderOpen, Hand, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, LoaderCircle, Pause, Play, ScrollText, Send, Sparkles, Square, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import type { AllowedAction, Decision, FlowOperation, Integration, Plan, ProjectFlowSnapshot, Round, Task, TaskStatus, TaskSupplement, FlowCompletionReport, StudyRoomDocuments } from '../shared/project-flow';
import {FLOW_LIMITS,reviewLevel,roundLead,roundReviewLevel,REVIEW_LEVEL_LABELS,REVIEW_LEVEL_HINTS,QUOTA_STAGE_LABELS,type ReviewLevel,type DisputeRuling} from '../shared/project-flow';
import type { Project, RoomId, RoomMessage, Snapshot } from '../shared/types';
import {commandExitCodeNotes} from '../shared/project-flow-review';
import {criterionText,criterionKind} from '../shared/project-flow';
import {STUDY_AUTO_ROUND_LIMIT} from '../shared/study-continuation';
import {memberCriteria} from '../shared/project-flow-review';
import {ReviewDetails} from './review-details';
import { Avatar, useTeam, type TeamMember } from './members';
import { RoomView, type RoomFocus } from './room';
import type { AttentionItem } from '../shared/attention';
import { Markdown, inline as renderInlineMd } from './Markdown';
import { ProjectDocument, type DocumentSelection } from './project-document';
import { useSidePanelWidth } from './side-panel-width';
import { ProjectMaterialsModal } from './project-tree';
import { migrateProjectMembers, projectMembers, saveProjectMembers } from './project-members';
import { dateTime, runnable, time, type Invoke } from './ui';
import { planChanges } from '../shared/plan-changes';
import { Modal } from './modals';
import { MemberConfigFields, MemberRunConfig } from './member-config';
import { ReportSwitcher, type ReportEntry } from './report-switcher';
import type {RoundtableSource} from '../shared/roundtable';
import {useRoundtableNavigation} from './roundtable-navigation';
import { SddModal } from './sdd-modal';
import type { SddState } from '../shared/sdd';
import {JOINT_READS} from '../shared/joint-review';
import type { ConfigSelection } from '../shared/executor-config';

const ROUND_STATUS: Record<Round['status'], string> = { pending: '未开始', executing: '进行中', integrating: '正在整合', checking: '整合检查中', awaiting_acceptance: '待验收', accepted: '已验收', changes_requested: '修改中', blocked: '已阻塞' };
const TASK_STATUS: Record<TaskStatus, string> = { pending: '待开始', ready: '可以开始', queued: '排队中', running: '进行中', awaiting_review: '待复核', correcting: '修正中', review_passed: '复核通过', review_skipped:'已提交，省略复核',integrated: '已整合', accepted: '已验收', escalated: '需要重新安排', blocked: '已阻塞', cancelled: '已取消' };
/** Board columns in the order work moves through them; 需处理 appears only when something is stuck. */
const LANES: { id: string; label: string; statuses: TaskStatus[] }[] = [
  { id: 'todo', label: '待开始', statuses: ['pending', 'ready', 'queued'] },
  { id: 'doing', label: '进行中', statuses: ['running', 'correcting'] },
  { id: 'review', label: '待复核', statuses: ['awaiting_review'] },
  { id: 'done', label: '已完成', statuses: ['review_passed','review_skipped', 'integrated', 'accepted'] },
  { id: 'stuck', label: '需处理', statuses: ['blocked', 'escalated', 'cancelled'] },
];
function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const sec = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const min = Math.floor(sec / 60);
  return <>已用 {min > 0 ? `${min} 分 ${sec % 60} 秒` : `${sec} 秒`}</>;
}

const STEPS = ['讨论', '定负责人', '方案', '执行', '验收', '完成'];
/** Reads never trigger a full workbench refresh; the room reloads itself when the flow overview moves. */
export const PROJECT_FLOW_READS = [...JOINT_READS,...PROGRESS_READS,...WORKBENCH_READS,...RESULT_READS,...LOG_READS, 'project.openPath','projectFlow.get', 'projectFlow.detail', 'projectFlow.history', 'projectFlow.artifact.files', 'projectFlow.artifact.read', 'projectFlow.artifact.diff'];
const REJECT_DEFAULT = '用户驳回了这一轮成品，请负责人复查并安排修正。';
const OPERATION_KIND: Record<string, string> = { plan: '起草方案', task: '做任务', review: '复核', 'integration-check': '整合检查', 'round-report': '写本轮汇报', rearrange: '重新安排', 'supplement-delivery': '补充要求',adjudication:'裁定复核异议','next-round':'下一轮调整建议','requested-check':'按你的要求检查整轮' };

const requestId = () => crypto.randomUUID();
const action = (list: AllowedAction[] | undefined, name: string) => list?.find(item => item.name === name);
const allowed = (list: AllowedAction[] | undefined, name: string) => action(list, name)?.enabled !== false;

/** A project's own meeting room: the shared chat (the same as 茶歇室, in this project's room) beside its board.
 *  Flow messages in the chat show as short cards; what needs the owner now sits in a dock above the composer, so
 *  clearing the chat never hides an action. Every change goes through the projectFlow methods with the target's revision. */
export function ProjectRoom({ snapshot, project, invoke, onOpenSession,onRoundtable,reports=[],onOpenReport,onOpenAttention }: { snapshot: Snapshot; project: Project; invoke: Invoke; onOpenSession: (sessionId: string, repair?: { targetProjectId: string; memberId: string }) => void;onRoundtable?:(source:Omit<RoundtableSource,'projectId'>|{topicId:string})=>void;reports?:ReportEntry[];onOpenReport?:(memberId:string)=>void; onOpenAttention:(item:AttentionItem)=>void }) {
  const team = useTeam();
  const [logTarget,setLogTarget]=useState<LogTarget|null>(null);
  const [document, setDocument] = useState<DocumentSelection>();
  const activeDocument = document?.projectId === project.id ? document : undefined;
  const panelWidth = useSidePanelWidth('fountain.projectPanelWidth');
  const parentProject = snapshot.projects.find(item=>item.id===project.parentId && !item.kind);
  const [materials,setMaterials] = useState(false);
  const [boardOpen,setBoardOpen]=useState(()=>{try{return localStorage.getItem('fountain.projectBoard')!=='closed';}catch{return true;}});
  const toggleBoard=(open:boolean)=>{setBoardOpen(open);try{localStorage.setItem('fountain.projectBoard',open?'open':'closed');}catch{}};
  const [includePreviousRecord,setIncludePreviousRecord]=useState(true),[addition,setAddition]=useState<{memberId:string;goal:string;task?:Task;proposal?:TaskAddition}|null>(null);
  const [boardView,setBoardView]=useState<'work'|'code'|'terminal'|'progress'>('work');
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [checkpointTrigger, setCheckpointTrigger] = useState(0);
  const [memberPopoverId, setMemberPopoverId] = useState<string | null>(null);
  const [focusTerminalId, setFocusTerminalId] = useState<string | undefined>(undefined);
  useEffect(()=>{setBoardView('work');setFanoutOpen(false);setMemberPopoverId(null);setFocusTerminalId(undefined);},[project.id]);
  useEffect(() => {
    const onCmd = (ev: Event) => {
      const cmd = (ev as CustomEvent<string>).detail;
      if (cmd === 'open-code') { toggleBoard(true); setBoardView('code'); }
      else if (cmd === 'toggle-scripts') { toggleBoard(true); setBoardView(v => (v === 'terminal' ? 'work' : 'terminal')); }
      else if (cmd === 'open-sdd') setSddOpen(true);
      else if (cmd === 'open-fanout') setFanoutOpen(true);
      else if (cmd === 'toggle-board') toggleBoard(!boardOpen);
      else if (cmd === 'create-checkpoint') { toggleBoard(true); setBoardView('code'); setCheckpointTrigger(n => n + 1); }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === 'b' && !ev.shiftKey) { ev.preventDefault(); toggleBoard(!boardOpen); }
      else if (k === 'j' && !ev.shiftKey) { ev.preventDefault(); toggleBoard(true); setBoardView(v => (v === 'terminal' ? 'work' : 'terminal')); }
      else if (k === 's' && ev.shiftKey) { ev.preventDefault(); setSddOpen(true); }
      else if (k === 'f' && ev.shiftKey) { ev.preventDefault(); setFanoutOpen(true); }
      else if (k === 'g' && ev.shiftKey) { ev.preventDefault(); toggleBoard(true); setBoardView('code'); }
    };
    window.addEventListener('fountain:cmd', onCmd);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('fountain:cmd', onCmd);
      window.removeEventListener('keydown', onKey);
    };
  }, [boardOpen]);
  const [sddOpen, setSddOpen] = useState(false);
  const [sddSummary, setSddSummary] = useState<SddState | null>(null);
  useEffect(() => {
    let alive = true;
    void invoke<SddState>('sdd.get', { projectId: project.id })
      .then((res) => { if (alive) setSddSummary(res); })
      .catch(() => { if (alive) setSddSummary(null); });
    return () => { alive = false; };
  }, [project.id, sddOpen, snapshot.runs.length, invoke]);
  const [config,setConfig]=useState<{memberId:string;value:ConfigSelection;revision:number}|null>(null),[configBusy,setConfigBusy]=useState(false),[configError,setConfigError]=useState('');
  useEffect(()=>{setConfig(null);setConfigError('');},[project.id]);
  useEffect(()=>setLogTarget(null),[project.id]);
  const roomId = `project:${project.id}` as RoomId;
  const [data, setData] = useState<ProjectFlowSnapshot | null>(null), [error, setError] = useState('');
  const [studyDocs,setStudyDocs]=useState<StudyRoomDocuments|null>(null);
  const [missingStudy,setMissingStudy]=useState<string>();
  async function initializeRoom(){
    setBusy(true);
    try {
      const documents=await invoke<StudyRoomDocuments>('project.study.initialize',{projectId:project.id});
      setStudyDocs(documents);setMissingStudy(undefined);setError('');
    }catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }
  const [busy, setBusy] = useState(false), [starting, setStarting] = useState(false), [picking, setPicking] = useState(false);
  const [newReviewLevel,setNewReviewLevel]=useState<ReviewLevel>('medium'), [dockOpen, setDockOpen] = useState(true);
  const [dockView, setDockView] = useState<'dock' | 'full' | 'window'>('dock');
  const [roomFocus, setRoomFocus] = useState<RoomFocus>();
  const [focusedTask, setFocusedTask] = useState<{ task: Task; nonce: number }>();
  function openHudTask(task: Task) {
    toggleBoard(true);
    setBoardView('work');
    setFocusedTask({ task, nonce: Date.now() });
  }
  const nextStepBody = useRef<HTMLDivElement>(null);
  const [dockSunk, setDockSunk] = useState(true);
  const [dockFocus, setDockFocus] = useState<{ target: string }>();
  const appliedDockFocus = useRef<typeof dockFocus>(undefined);
  function revealStep(target: string) {
    if (target === '[data-flow-next="plan"]') setDockView('full');
    setDockSunk(false);
    setDockOpen(true);
    setDockFocus({ target });
  }
  useEffect(() => {
    if (!dockFocus || appliedDockFocus.current === dockFocus || dockSunk || !dockOpen) return;
    const body = nextStepBody.current;
    if (!body) return;
    appliedDockFocus.current = dockFocus;
    const node = body.querySelector<HTMLElement>(dockFocus.target) ?? body;
    node.scrollIntoView({ block: 'nearest' });
    node.tabIndex = -1;
    node.focus({ preventScroll: true });
    node.classList.remove('flow-step-flash');
    void node.offsetWidth;
    node.classList.add('flow-step-flash');
    const timer = window.setTimeout(() => node.classList.remove('flow-step-flash'), 1400);
    return () => { window.clearTimeout(timer); node.classList.remove('flow-step-flash'); };
  }, [dockFocus, dockSunk, dockOpen, dockView]);
  const ready = (member: TeamMember) => runnable(snapshot.providers.find(info => info.id === member.executor));
  // Who takes part: chosen in 请大家一起来 (or the running flow's team); the chips above the composer change it.
  const [roster, setRoster] = useState<string[]>(() => projectMembers(project));
  // The saved list is the truth; a list kept by an older version in this browser moves onto the project once.
  useEffect(() => { setRoster(projectMembers(project)); }, [project.id, JSON.stringify(project.memberIds)]);
  useEffect(() => { void migrateProjectMembers(invoke, project); }, [project.id]);
  const loading = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++loading.current;
    try { const result = await invoke<ProjectFlowSnapshot>('projectFlow.get', { projectId: project.id }); if (ticket === loading.current) { setData({...result,jointReviews:result.jointReviews??[],blockedOperations:result.blockedOperations??[]}); setError(''); } }
    catch (cause) { if (ticket === loading.current) setError((cause as Error).message); }
  }, [invoke, project.id]);
  // The overview in every snapshot says when this project's flow moved; reload then, not on unrelated broadcasts.
  const overview = snapshot.projectFlows?.find(item => item.projectId === project.id);
  const stamp = JSON.stringify([overview,snapshot.jointReviews?.filter(r=>r.projectId===project.id), snapshot.runs.filter(run => run.projectId === project.id && run.flowOperationId).map(run => [run.id, run.status, run.updatedAt])]);
  useEffect(() => { void load(); }, [load, stamp]);
  // Blocked attempts share the same saved revision as the board and reasons.
  const blocked = data?.blockedOperations ?? [];
  useEffect(() => { setData(null); setStarting(false); setPicking(false); }, [project.id]);

  const flow = data?.flow ?? null, plan = data?.plan ?? null;
  const live = Boolean(flow && !['completed', 'cancelled'].includes(flow.status));
  const fresh = !flow || !live && starting;
  // A team that already works on this project is its roster until the owner picks people.
  useEffect(() => { if (!roster.length && flow?.memberIds.length) setRoster(flow.memberIds); }, [flow?.id]);
  const changeRoster = (ids: string[]) => { setRoster(ids); void saveProjectMembers(invoke, project.id, ids).catch(() => setRoster(projectMembers(project))); };
  const rounds = useMemo(() => (data?.rounds ?? []).filter(round => round.planId === flow?.activePlanId).sort((a, b) => a.index - b.index), [data, flow?.activePlanId]);
  const tasks = useMemo(() => (data?.tasks ?? []).filter(task => task.planId === flow?.activePlanId), [data, flow?.activePlanId]);
  const awaitingRound = rounds.find(round => round.status === 'awaiting_acceptance' && round.requiresUserAcceptance);
  // Stuck tasks with no blocked attempt to give up: 继续 retries them (the backend decides which; this only decides what to show).
  const stuckTasks = tasks.filter(task => task.status === 'blocked' && !(data?.decisions ?? []).some(d => d.status === 'open' && d.taskId === task.id));
  const roomOverview = snapshot.rooms?.find(room => room.roomId === roomId);
  const quotaWaits = data?.quotaWaits ?? [];
  const repairMembers = team.members.filter(member => {
    const provider = snapshot.providers.find(info => info.id === member.executor);
    return provider?.available && provider.capabilities.write &&
      !roomOverview?.state.restingMemberIds?.includes(member.id);
  });
  const replacementMembers = (task: Task) => repairMembers.filter(member => member.id !== task.memberId && flow?.memberIds.includes(member.id));
  const waitingTasks = tasks.filter(task =>
    action(task.allowedActions, 'projectFlow.task.reassign')?.enabled &&
    (stuckTasks.some(stuck => stuck.id === task.id) || roomOverview?.state.restingMemberIds?.includes(task.memberId) || roomOverview?.skippedMemberIds?.includes(task.memberId) ||
      quotaWaits.some(wait => wait.stage === 'task' && wait.targetId === task.id)));
  const canRetry = Boolean(flow && (flow.blockedReasons.length || stuckTasks.length));
  const step = fresh ? (picking ? 1 : 0) : flow!.status === 'completed' ? 6 : flow!.status === 'cancelled' ? -1 : flow!.status !== 'active' ? 2 : awaitingRound ? 4 : 3;

  const resolveAttempt=(op:FlowOperation,choice:'abandon'|'continue',evidence:string)=>mutate('projectFlow.unknown.resolve',{operationId:op.id,expectedRevision:op.revision,choice,evidence},choice==='continue'?'已记录接着做：沿用原会话和工作副本。':'已放弃这次尝试，历史记录保留。');
  const giveUp = (op: FlowOperation, evidence: string) => resolveAttempt(op,'abandon',evidence);
  const resultUnknown = (op: FlowOperation) => { const run = snapshot.runs.find(item => item.id === (op.correctionRunId ?? op.runId)); return Boolean(run && (run.status === 'unknown' || run.delivery === 'unknown') || data?.tasks.some(task => task.supplements?.some(item => item.status === 'unknown' && item.deliveryOperationId === op.id))); };
  const reassign = (task: Task, memberId: string, op?: FlowOperation) => op
    ? mutate('projectFlow.unknown.resolve', { operationId: op.id, expectedRevision: op.revision, expectedTaskRevision: task.revision, choice: 'abandon', memberId, evidence: '用户确认结束旧尝试并换人接手。' }, '旧尝试已结束，新成员已接手。流程暂停时请点「继续」。')
    : mutate('projectFlow.task.reassign', { taskId: task.id, expectedRevision: task.revision, memberId }, '新成员已接手。流程暂停时请点「继续」。');
  async function dispatchSoftwareRepair(memberId: string, errorSummary: string, op?: FlowOperation) {
    setBusy(true);
    setError('');
    const params = { projectId: project.id, memberId, runId: op?.correctionRunId ?? op?.runId, scope: 'software', errorSummary: plainFlowError(errorSummary) };
    try {
      const send = (sourceDirectory?: string) => invoke<{ sessionId?: string; targetProjectId: string; memberId: string }>('project.selfHeal.dispatch', { ...params, sourceDirectory }, '已启动软件修复会话。', { background: true });
      let result;
      try {
        result = await send();
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.includes('请先在工作台添加 FountAIn 源码目录')) throw cause;
        const directory = await invoke<string | null>('dialog.directory');
        if (!directory) return false;
        result = await send(directory);
      }
      setDockOpen(false);
      if (result.sessionId) onOpenSession(result.sessionId, result);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function mutate(method: string, params: Record<string, unknown>, success?: string) {
    setBusy(true);
    try { await invoke(method, { requestId: requestId(), ...params }, success); await load(); return true; } catch { await load(); return false; } finally { setBusy(false); }
  }
  async function decide(round: Round, integration: Integration, verdict: 'pass' | 'reject', reason = '') {
    if (verdict === 'pass') return mutate('projectFlow.round.accept', { roundId: round.id, expectedRevision: round.revision, integrationId: integration.id, fingerprint: integration.version?.fingerprint, opinion: '验收通过' }, '已通过，正在把成品写入项目。');
    return mutate('projectFlow.round.requestChanges', { roundId: round.id, expectedRevision: round.revision, integrationId: integration.id, opinion: reason.trim() || REJECT_DEFAULT }, '已驳回，负责人会安排修正。');
  }
  /** The plan is drafted from this room's discussion, which the backend brings along; it says so when there is none yet. */
  async function start(leadMemberId: string, memberIds: string[], topic?: string) {
    const trimmed = topic?.trim();
    const mergedOrder = [...memberIds, ...roster.filter(id => !memberIds.includes(id))];
    if (JSON.stringify(mergedOrder) !== JSON.stringify(roster)) changeRoster(mergedOrder);
    const ok = await mutate('projectFlow.start', { projectId: project.id, leadMemberId, memberIds, reviewLevel: newReviewLevel, includePreviousRecord, ...(trimmed ? { topic: trimmed } : {}) }, '已请负责人根据讨论起草方案，你确认后才开工。');
    if (ok) { setStarting(false); setPicking(false); setError(''); }
  }

  const people = roster.map(id => team.get(id)).filter((member): member is TeamMember => Boolean(member));
  /** task workspace: continue the task from its ROOM_BRIEF / HANDOFF instead of opening a new topic. */
  const briefLeader = project.meetingLeaderId ? people.find(member => member.id === project.meetingLeaderId) : undefined;
  async function resumeFromBrief() {
    if (!briefLeader) return;
    const memberIds = people.filter(ready).map(member => member.id);
    if (!memberIds.includes(briefLeader.id)) { setError(`${briefLeader.name} 还没准备好，先在设置里检查连接。`); return; }
    const ok = await mutate('projectFlow.start', { projectId: project.id, leadMemberId: briefLeader.id, memberIds, reviewLevel: newReviewLevel, includePreviousRecord, topic: RESUME_TOPIC }, `已请 ${briefLeader.name} 按门牌接续当前阶段起草方案，你确认后才开工。`);
    if (ok) { setStarting(false); setPicking(false); setError(''); }
  }
  const planOp = blocked.find(op => op.kind === 'plan');
  const revisingPlan = Boolean(live && plan && flow?.status === 'planning' && !planOp && flow.dispatchMode === 'running');
  const actionable = (round: Round) => { const acceptance = data?.acceptances.find(item => item.id === round.acceptanceId); return round.status === 'awaiting_acceptance' && round.requiresUserAcceptance || ['recovery_required', 'conflict', 'applying'].includes(acceptance?.status ?? ''); };
  const openDecisions = (data?.decisions ?? []).filter(item => item.status === 'open');
  const lastAccepted = rounds.filter(round => round.status === 'accepted').at(-1), lastAcceptance = lastAccepted && data?.acceptances.find(item => item.id === lastAccepted.acceptanceId);
  const acceptedLine = lastAccepted && lastAcceptance?.acceptedAt ? lastAcceptance.actor === 'lead' ? `第 ${lastAccepted.index + 1} 轮「${lastAccepted.title}」负责人自验通过，已进入第 ${lastAccepted.index + 2} 轮；成品会在你下次验收时一起写回项目` : `第 ${lastAccepted.index + 1} 轮「${lastAccepted.title}」已验收 · ${dateTime(lastAcceptance.acceptedAt)} 写回项目` : '';
  const roundOf = (roundId?: string) => { const round = rounds.find(item => item.id === roundId); return round ? `第 ${round.index + 1} 轮：` : ''; };
  const currentRound = rounds.find(round => round.id === flow?.currentRoundId) ?? rounds.find(round => round.status !== 'accepted');
  const activeFlowRuns = useMemo(() => {
    if (!live || !flow) return [];
    const purposeLabel: Record<string, string> = { 'flow-plan': '起草/修改方案', 'flow-task': '执行任务', 'flow-review': '复核成果', 'flow-integration': '整合检查与整理汇报' };
    return snapshot.runs
      .filter(run => run.projectId === project.id && ['queued', 'running'].includes(run.status))
      .map(run => {
        const session = snapshot.sessions.find(s => s.id === run.sessionId);
        if (!session || (session.flowId !== flow.id && !session.purpose?.startsWith('flow-'))) return null;
        return { id: run.id, memberId: session.memberId ?? flow.leadMemberId, label: purposeLabel[session.purpose ?? ''] ?? '处理本轮工作', startedAt: run.createdAt };
      })
      .filter((item): item is { id: string; memberId: string; label: string; startedAt: string } => Boolean(item));
  }, [live, flow?.id, flow?.leadMemberId, project.id, snapshot.runs, snapshot.sessions]);
  const checkingRound = Boolean(live && flow?.status === 'active' && currentRound && ['integrating', 'checking'].includes(currentRound.status) && !actionable(currentRound) && blocked.length === 0 && openDecisions.length === 0 && activeFlowRuns.length === 0);
  const roundTasks = useMemo(() => currentRound ? tasks.filter(t => t.roundId === currentRound.id) : tasks, [tasks, currentRound?.id]);
  const latestSubmission = (taskId: string) => (data?.submissions ?? []).filter(s => s.taskId === taskId && s.status !== 'invalid').sort((a, b) => b.sequence - a.sequence)[0];
  const progressBriefs = useMemo(() => {
    if (!live || flow?.status !== 'active') return [];
    return roundTasks.flatMap(task => {
      const sub = latestSubmission(task.id);
      if (sub && ['review_passed', 'review_skipped', 'integrated', 'accepted', 'awaiting_review'].includes(task.status)) {
        const text = (sub.userSummary || sub.summary || '').replace(/^\s*#{1,6}\s+(.+?)\s*#*$/gm, '【$1】').replace(/\s+/g, ' ').trim();
        const fileCount = sub.changedFileCount ?? sub.changes?.length ?? 0;
        return [{ id: task.id, memberId: task.memberId, done: true, title: task.title, text: text || `已完成「${task.title}」`, fileCount }];
      }
      if (['running', 'correcting'].includes(task.status)) {
        return [{ id: task.id, memberId: task.memberId, done: false, title: task.title, text: `正在做「${task.title}」…`, fileCount: 0 }];
      }
      return [];
    });
  }, [live, flow?.status, roundTasks, data?.submissions]);
  const roundCard = (round: Round) => <RoundCard key={round.id} round={round} lead={roundLead(flow!,round)} data={data!} invoke={invoke} busy={busy} onDecide={decide} onCheck={(round,integration,memberId)=>mutate('projectFlow.round.requestCheck',{roundId:round.id,expectedRevision:round.revision,integrationId:integration.id,memberId},'已安排一次整轮检查，结果交回你决定。')}
    onRecover={(acceptanceId, revision, choice) => mutate('projectFlow.acceptance.recover', { acceptanceId, expectedRevision: revision, choice }, choice === 'continue' ? '已继续写入剩下的文件。' : '已核对写入结果。')} />;

  // What needs the owner now, in the order the work asks for it.
  const items = !data ? null : <>
    {fresh ? (picking
      ? <div className="kickoff-unified">
          <div className="kickoff-mode-bar" role="group" aria-label="立项模式选择">
            <span className="kickoff-mode-pill active"><Hand size={13} />快速立项（单人起草方案）</span>
            <button type="button" className="kickoff-mode-pill sdd" onClick={() => { setPicking(false); setSddOpen(true); }}><GitCompareArrows size={13} />改用 SDD 双盲规范立项（宪法 → Spec → 双盲对照）</button>
          </div>
          <LeadPicker team={people} initialLead={project.meetingLeaderId} ready={ready} busy={busy} onOrderChange={changeRoster} onCancel={() => setPicking(false)} onStart={start} />
        </div>
      : <div className="dock-row"><Sparkles size={15} /><p>{flow && !live ? '上一段工作已经结束。' : ''}讨论清楚后点击右侧<strong>「立项 / 起草方案」</strong>（支持快速立项或 SDD 双盲规范）；<strong>你确认方案后才开工</strong>。</p>{briefLeader&&<button type="button" className="button small primary" disabled={busy} onClick={() => void resumeFromBrief()}><Sparkles size={13} />请 {briefLeader.name} 接续门牌当前阶段</button>}</div>)
    : <>
      {!live && <div className="dock-row"><CheckCircle2 size={15} /><p>{flow!.status === 'completed' ? '这段工作已经完成，成品已写回项目。' : '这段工作已取消，记录和成果都保留着。'}</p><button type="button" className="button small primary" disabled={busy} onClick={() => setStarting(true)}><Sparkles size={13} />开始新的一段工作</button></div>}
      {!live && flow!.completionReport && <CompletionReport report={flow!.completionReport} />}
      {live && flow!.status === 'planning' && !plan && (planOp || flow!.dispatchMode !== 'running'
        ? <div className="dock-row"><AlertTriangle size={15} /><p><strong>方案起草已停止。</strong>{planOp ? '在下面的提示里放弃这次起草，再点右上角“继续”，负责人会重新起草。' : '点右上角“继续”，负责人会接着起草。'}</p></div>
        : <div className="dock-row"><LoaderCircle size={15} className="spin" /><p><MemberName id={flow!.leadMemberId} /> 正在根据讨论起草方案…</p></div>)}
      {revisingPlan && <div className="dock-row"><LoaderCircle size={15} className="spin" /><p><strong><MemberName id={flow!.leadMemberId} /> 正在按你的意见修改方案…</strong>（完成后会自动更新为新版方案）</p></div>}
      {live && plan && (plan.status === 'awaiting_confirmation') && <div data-flow-next="plan"><PlanCard plan={plan} invoke={invoke} lead={flow!.leadMemberId} rounds={rounds} busy={busy || revisingPlan} defaultLevel={reviewLevel(flow!)} onRoundLevel={(round,level)=>mutate('projectFlow.review.configure',{flowId:flow!.id,expectedRevision:flow!.revision,roundId:round.id,reviewLevel:level},'本轮复核程度已调整。')} onConfirm={(choices,peerChoices,levels,studyContinuation,waitForFirstRoundStart) => mutate('projectFlow.plan.confirm', { planId: plan.id, expectedRevision: plan.revision, requiresUserAcceptanceByRound: choices,requiresPeerReviewByRound:peerChoices,reviewLevelByRound:levels,studyContinuation,waitForFirstRoundStart }, waitForFirstRoundStart ? '方案已确认，等待你启动第一轮。' : '方案已确认，开始派发任务。')} onRevise={instruction => mutate('projectFlow.plan.revise', { planId: plan.id, expectedRevision: plan.revision, instruction }, '已请负责人按你的意见改方案。')} /></div>}
      {live && (blocked.length > 0 || flow!.blockedReasons.length > 0 || stuckTasks.length > 0) && <div data-flow-next="blocked" className="meeting-alert" role="alert"><AlertTriangle size={15} /><div><strong>流程暂停了，需要你先看一下</strong>
        {blocked.length ? blocked.map(op => { const task = data.tasks.find(item => item.id === op.targetId); return <div key={op.id} className="meeting-alert-item">
          <p><strong>{OPERATION_KIND[op.kind] ?? op.kind}{task ? `：${task.title}` : ''}</strong>　{plainFlowError(op.error)}</p>
          <GiveUp task={op.kind === 'task'} unknown={resultUnknown(op)} supplement={op.kind === 'supplement-delivery'} busy={busy} onContinue={op.kind!=='supplement-delivery'?evidence=>resolveAttempt(op,'continue',evidence):undefined} onConfirm={evidence => giveUp(op, evidence)} />
          {task && <button type="button" className="link-button" onClick={() => setLogTarget({kind:'task',id:task.id})}>查看任务日志</button>}
          {task && op.kind === 'task' && <FlowMemberPicker key={op.revision} members={replacementMembers(task)} busy={busy} actions={[{ label: '结束旧尝试并换人', run: memberId => reassign(task, memberId, op) }]} />}
          <FlowMemberPicker members={repairMembers} busy={busy} actions={[
            { label: '排查并修复软件 Bug', run: memberId => dispatchSoftwareRepair(memberId, op.error ?? 'FountAIn 运行异常', op) },
          ]} />
        </div>; })
          : <>
            {[...new Set([...flow!.blockedReasons, ...stuckTasks.map(task => task.blockedReason ?? `${task.title} 卡住了`)])].map(reason => <p key={reason}>{plainFlowError(reason)}</p>)}
            <FlowMemberPicker members={repairMembers} busy={busy} actions={[
              { label: '排查并修复软件 Bug', run: memberId => dispatchSoftwareRepair(memberId, flow!.blockedReasons[0] ?? stuckTasks[0]?.blockedReason ?? 'FountAIn 运行异常') },
            ]} />
          </>}
        <small>{blocked.length ? '旧运行须先确认已结束。换人会保留历史记录，新成员从本轮起点接手；流程暂停时请点「继续」。' : '流程暂停时请在处理后点「继续」。'}</small>
        </div></div>}
      {live && waitingTasks.map(task => <div key={task.id} className="meeting-alert-item" data-flow-next="replacement">
        <p><MemberName id={task.memberId} /> 暂时无法处理「{task.title}」</p>
        <FlowMemberPicker members={replacementMembers(task)} busy={busy} actions={[{ label: '换人接手', run: memberId => reassign(task, memberId) }]} />
      </div>)}
      {live && quotaWaits.map(wait => <div key={wait.id} className="dock-row"><LoaderCircle size={15} className="spin" /><p>等待 <MemberName id={wait.memberId} /> 额度恢复 · {QUOTA_STAGE_LABELS[wait.stage]} · 从 {time(wait.startedAt)} 开始。</p></div>)}
      {live && openDecisions.map(decision => {
        const leadId = roundLead(flow!, currentRound);
        const leadName = team.get(leadId)?.name ?? '负责人';
        const repairTask = decision.kind === 'unresolved-review' ? tasks.find(task => task.id === decision.taskId) : undefined;
        return <div key={decision.id} data-flow-next="decision" data-flow-detail={decision.id}>{repairTask && <div className="meeting-card" data-flow-next="repair">
          <strong>指定成员修复并补证据</strong>
          <p>在上次提交的副本中修复，补齐实际核验记录后重新复核。</p>
          <FlowMemberPicker members={repairMembers.filter(member => flow!.memberIds.includes(member.id))} busy={busy} actions={[{
            label: '开始修复',
            run: memberId => mutate('projectFlow.decision.answer', { decisionId: decision.id, expectedRevision: decision.revision, choice: '指定成员补充依据', memberId }, '已安排修复，完成后会汇报结果。'),
          }]} />
        </div>}<DecisionCard decision={decision} tasks={data.tasks} rounds={data.rounds} busy={busy} leadName={leadName} onAskLead={repairTask ? undefined : async (d) => {
          const opts = d.options.join(' / ');
          const text = `@${leadName} 请用通俗大白话帮我解释一下「${d.title}」为什么卡住了，具体哪里出了问题，并建议我从这几个选项里选哪一个（${opts}）。`;
          await invoke('room.send', { roomId, text, memberIds: roster, mode: 'discuss', style: 'chat', maxMinutes: 0, handRaise: false, hostPick: false });
          setDockOpen(false);
        }} onAnswer={params => mutate('projectFlow.decision.answer', { decisionId: decision.id, expectedRevision: decision.revision, ...params }, '已记录你的决定。')} /></div>;
      })}
      {live && rounds.filter(actionable).map(round=><div key={round.id} data-flow-next="acceptance" data-flow-detail={round.id}>{roundCard(round)}</div>)}
      {acceptedLine && <div className="dock-row"><CheckCircle2 size={15} /><p>{acceptedLine}</p></div>}
      {activeFlowRuns.map(run => {
        const runEvents = snapshot.events
          .filter(ev => ev.runId === run.id && ['tool', 'reasoning', 'status', 'error'].includes(ev.kind) && ev.text?.trim())
          .slice(-12);
        const latestDelta = snapshot.events
          .filter(ev => ev.runId === run.id && ev.kind === 'delta' && ev.text)
          .slice(-8)
          .map(ev => ev.text)
          .join('')
          .trim();
        const latestHint = runEvents.at(-1)?.text?.replace(/\s+/g, ' ').trim() || latestDelta.replace(/\s+/g, ' ').slice(-80);
        return <details key={run.id} className="dock-progress-details">
          <summary className="dock-row dock-progress-item running">
            <LoaderCircle size={15} className="spin" />
            <div className="dock-progress-summary">
              <p><strong><MemberName id={run.memberId} /> 正在{run.label}…</strong><small className="dock-progress-meta">（启动于 {time(run.startedAt)} · <ElapsedTimer startedAt={run.startedAt} /> · 点此展开实时动态）</small></p>
              {latestHint && <small className="dock-progress-latest">{latestHint.slice(0, 120)}{latestHint.length > 120 ? '…' : ''}</small>}
            </div>
          </summary>
          <div className="dock-progress-live">
            {runEvents.length === 0 && !latestDelta
              ? <p className="dock-progress-empty">已发出任务指令，正在等待模型返回思考或工具调用记录…</p>
              : <>
                {runEvents.map(ev => <div key={ev.id} className={`dock-live-row kind-${ev.kind}`}>
                  <span className="dock-live-time">{time(ev.at)}</span>
                  <span className="dock-live-kind">{ev.kind === 'tool' ? '工具' : ev.kind === 'reasoning' ? '思考' : ev.kind === 'error' ? '报错' : '状态'}</span>
                  <span className="dock-live-text">{ev.text.replace(/\s+/g, ' ').slice(0, 260)}{ev.text.length > 260 ? '…' : ''}</span>
                </div>)}
                {latestDelta && <div className="dock-live-row kind-delta">
                  <span className="dock-live-time">输出</span>
                  <span className="dock-live-kind">正文</span>
                  <span className="dock-live-text">{latestDelta.slice(-260)}</span>
                </div>}
              </>}
          </div>
        </details>;
      })}
      {checkingRound && currentRound && (flow!.dispatchMode === 'running'
        ? <div className="dock-row dock-progress-item running"><LoaderCircle size={15} className="spin" /><p><strong><MemberName id={roundLead(flow!, currentRound)} /> 正在做本轮整体检查并整理汇总汇报…</strong>（完成后会自动弹出「待你处理」验收卡片）</p></div>
        : <div className="dock-row dock-progress-item"><Pause size={15} /><p><strong>本轮整体检查已暂停</strong>（点击右侧「继续这段工作」即可恢复）</p></div>)}
      {progressBriefs.length > 0 && <div className="dock-progress-list">{progressBriefs.map(item => <div key={item.id} className={`dock-row dock-progress-item ${item.done ? 'done' : 'running'}`}>
        {item.done ? <CheckCircle2 size={15} /> : <LoaderCircle size={15} className="spin" />}
        <p><MemberName id={item.memberId} />：{renderInlineMd(item.text)}{item.done && item.fileCount > 0 ? <small className="dock-progress-meta">（改动 {item.fileCount} 个文件）</small> : null}</p>
      </div>)}</div>}
    </>}
  </>;
  // Folded, the dock says what waits first (or where the work stands); a new item to handle opens it.
  const waiting: string[] = [], standing: string[] = [];
  if (data) {
    if (fresh) standing.push(picking ? '选一位负责人，由 TA 根据讨论起草方案' : '讨论清楚后，选负责人起草方案');
    else {
      if (!live) standing.push(flow!.status === 'completed' ? '这段工作已经完成，成品已写回项目' : '这段工作已取消，记录和成果都保留着');
      if (live && flow!.status === 'planning' && !plan) { if (planOp || flow!.dispatchMode !== 'running') waiting.push('方案起草已停止'); else standing.push(`${team.get(flow!.leadMemberId)?.name ?? '负责人'} 正在根据讨论起草方案…`); }
      if (revisingPlan) standing.unshift(`${team.get(flow!.leadMemberId)?.name ?? '负责人'} 正在修改方案…`);
      if (live && flow!.waitingForFirstRoundStart) waiting.push('启动第一轮');
      if (live && plan?.status === 'awaiting_confirmation' && !revisingPlan) waiting.push(`确认方案第 ${plan.version} 版`);
      if (live && (blocked.length > 0 || flow!.blockedReasons.length > 0 || stuckTasks.length > 0)) waiting.push('流程暂停了，需要你先看一下');
      if (live && waitingTasks.length) waiting.push(`有 ${waitingTasks.length} 项任务可以换人接手`);
      if (live) for (const wait of data.quotaWaits ?? []) standing.push(`等待 ${team.get(wait.memberId)?.name ?? '成员'} 额度恢复`);
      if (live) for (const decision of openDecisions) waiting.push(roundOf(decision.roundId) + decision.title);
      if (live) for (const round of rounds.filter(actionable)) waiting.push(`第 ${round.index + 1} 轮成品待验收`);
      if (activeFlowRuns.length > 0) standing.unshift(activeFlowRuns.map(r => `${team.get(r.memberId)?.name ?? '成员'} 正在${r.label}`).join(' · ') + '…');
      if (checkingRound && currentRound) standing.push(`${team.get(roundLead(flow!, currentRound))?.name ?? '负责人'} 正在整轮检查并整理汇报…`);
      if (progressBriefs.length > 0) {
        const doneNames = progressBriefs.filter(i => i.done).map(i => team.get(i.memberId)?.name ?? '成员');
        const runNames = progressBriefs.filter(i => !i.done).map(i => team.get(i.memberId)?.name ?? '成员');
        const parts: string[] = [];
        if (doneNames.length) parts.push(`已完成：${doneNames.join('、')}`);
        if (runNames.length) parts.push(`进行中：${runNames.join('、')}`);
        if (parts.length) standing.push(parts.join(' · '));
      }
      if (acceptedLine) standing.push(acceptedLine);
    }
  }
  const waitingKey = waiting.join('|');
  useEffect(() => { if (waitingKey) setDockOpen(true); }, [waitingKey]);
  const roundToAccept = live ? rounds.find(actionable) : undefined;
  function openAcceptance() {
    revealStep('[data-flow-next="acceptance"]');
    if (roundToAccept?.integrationId) {
      void invoke('project.openPath', {
        projectId: project.id, roundId: roundToAccept.id, integrationId: roundToAccept.integrationId,
        source: 'submitted', mode: 'folder',
      }).catch(cause => setError(`无法打开成品文件夹：${(cause as Error).message}`));
    }
  }
  const nextStep=live&&blocked.length?{label:'核对中断结果',run:()=>revealStep('[data-flow-next="blocked"]')}
    :live&&plan?.status==='awaiting_confirmation'?{label:'查看并确认方案',run:()=>revealStep('[data-flow-next="plan"]')}
    :live&&waitingTasks.length?{label:'选择成员接手',run:()=>revealStep('[data-flow-next="replacement"]')}
    :live&&openDecisions.length?{label:'处理当前决定',run:()=>revealStep('[data-flow-next="decision"]')}
    :roundToAccept?{label:'查看成品并验收',run:openAcceptance}
    :live&&flow!.dispatchMode!=='running'&&allowed(data!.allowedActions,'projectFlow.resume')?{label:flow!.waitingForFirstRoundStart?'启动第一轮':'继续这段工作',run:()=>void mutate('projectFlow.resume',{flowId:flow!.id,expectedRevision:flow!.revision},'已继续派发。')}:undefined;
  const speakingId = snapshot.rooms?.find(room => room.roomId === roomId)?.state.speaking;
  const attentionAlerts = (snapshot.attention?.items ?? []).filter(item =>
    (item.roomId === roomId || item.projectId === project.id) && ['unknown', 'approval', 'login'].includes(item.kind),
  );
  const sideAlerts: { key: string; label: string; tone: 'warn' | 'bad'; onClick: () => void }[] = [
    ...(live && plan?.status === 'awaiting_confirmation' ? [{ key: 'plan', label: `待审批 · 第 ${plan.version} 版方案`, tone: 'warn' as const, onClick: () => revealStep('[data-flow-next="plan"]') }] : []),
    ...(live && (blocked.length > 0 || flow!.blockedReasons.length > 0 || stuckTasks.length > 0) ? [{ key: 'blocked', label: '流程阻塞 · 点击查看', tone: 'bad' as const, onClick: () => revealStep(!blocked.length && openDecisions.some(decision => decision.kind === 'unresolved-review' && decision.taskId)
      ? '[data-flow-next="repair"]' : '[data-flow-next="blocked"]') }] : []),
    ...(live && openDecisions.length > 0 ? [{ key: 'decision', label: `待你决定 · ${openDecisions.length} 项`, tone: 'warn' as const, onClick: () => revealStep('[data-flow-next="decision"]') }] : []),
    ...(roundToAccept ? [{ key: 'accept', label: '待你验收 · 查看成品', tone: 'warn' as const, onClick: openAcceptance }] : []),
    ...attentionAlerts.map(item => ({
      key: `att-${item.id}`,
      label: `${item.kind === 'approval' ? '待授权' : item.kind === 'login' ? '待恢复连接' : '待核对'} · ${(item.memberId && team.get(item.memberId)?.name) || item.title}`,
      tone: 'warn' as const,
      onClick: () => {
        if (item.roomId === roomId && item.messageId) setRoomFocus({ threadId: item.threadId, messageId: item.messageId, nonce: Date.now() });
        else onOpenAttention(item);
      },
    })),
  ];
  const sddStageLabel: Record<string, string> = {
    idle: '未启动', spec_drafting: '起草 Spec…', spec_review: 'Spec 待审',
    blind_proposing: '双盲提案中…', synthesizing: '合成对照表中…', plan_review: '对照表待拍板', tasks_ready: '已转任务',
  };
  const sideHeaderSummary = <div className="side-summary-stack">
    {sideAlerts.length > 0 && <div className="side-alerts" role="status">{sideAlerts.map(a => <button key={a.key} type="button" className={`side-alert-pill tone-${a.tone}`} onClick={a.onClick}><span className="t3-dot t3-dot-needs" aria-hidden="true" /><span>{a.label}</span></button>)}</div>}
    {people.length > 0 && <div className="side-team-pulse-wrap">
      <div className="side-team-pulse" aria-label="成员实时状态">
        {people.map(member => {
          const isSpeaking = speakingId === member.id;
          const activeTask = live ? tasks.find(t => t.memberId === member.id && ['running', 'correcting', 'reviewing'].includes(t.status)) : undefined;
          const isLead = (live ? flow?.leadMemberId : project.meetingLeaderId) === member.id;
          const stateText = isSpeaking ? '发言中' : activeTask ? TASK_STATUS[activeTask.status] : ready(member) ? '待命' : '离线';
          const selected = memberPopoverId === member.id;
          return <button key={member.id} type="button" className={`side-pulse-chip member-${member.id} ${isSpeaking || activeTask ? 'is-working' : ''} ${selected ? 'is-selected' : ''}`} title={`${member.name}${isLead ? '（Leader）' : ''} · ${stateText}（点击打开终端或汇报）`} onClick={() => setMemberPopoverId(prev => (prev === member.id ? null : member.id))}>
            <Avatar member={member} size={20} ring={false} mood={isSpeaking || activeTask ? 'working' : undefined} />
            <span className="side-pulse-name">{member.name}</span>
            <span className={`t3-dot ${isSpeaking || activeTask ? 't3-dot-working' : ready(member) ? 't3-dot-idle' : 't3-dot-off'}`} aria-hidden="true" />
          </button>;
        })}
      </div>
      {memberPopoverId && (() => {
        const target = people.find(m => m.id === memberPopoverId);
        if (!target) return null;
        const idx = roster.indexOf(target.id);
        const moveToFirst = () => {
          if (idx <= 0) return;
          changeRoster([target.id, ...roster.filter(id => id !== target.id)]);
        };
        const shift = (delta: -1 | 1) => {
          const nextIdx = idx + delta;
          if (idx < 0 || nextIdx < 0 || nextIdx >= roster.length) return;
          const next = [...roster];
          [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
          changeRoster(next);
        };
        return <div className="side-member-quickbar" role="group" aria-label={`${target.name} 快捷操作`}>
          <span className="side-member-quickbar-name">{target.name}{idx >= 0 ? ` · #${idx + 1}` : ''}</span>
          {idx > 0 && <button type="button" className="button small quiet" title="排到本房间开会第 1 位发言" onClick={moveToFirst}>设为首发</button>}
          {roster.length > 1 && <>
            <button type="button" className="button small quiet" disabled={idx <= 0} title="发言顺位提前一位" onClick={() => shift(-1)}>←</button>
            <button type="button" className="button small quiet" disabled={idx < 0 || idx >= roster.length - 1} title="发言顺位靠后一位" onClick={() => shift(1)}>→</button>
          </>}
          <button type="button" className="button small quiet" onClick={() => { setMemberPopoverId(null); void invoke<{ terminalId?: string }>('project.terminal.launchMember', { projectId: project.id, roomId, memberId: target.id, inheritContext: false }).then(res => { if (res?.terminalId) { setFocusTerminalId(res.terminalId); setBoardView('terminal'); } }).catch(e => setError((e as Error).message)); }}><Terminal size={11} />新开终端</button>
          <button type="button" className="button small secondary" onClick={() => { setMemberPopoverId(null); void invoke<{ terminalId?: string }>('project.terminal.launchMember', { projectId: project.id, roomId, memberId: target.id, inheritContext: true }).then(res => { if (res?.terminalId) { setFocusTerminalId(res.terminalId); setBoardView('terminal'); } }).catch(e => setError((e as Error).message)); }}><History size={11} />继承聊天开终端</button>
          {onOpenReport && <button type="button" className="button small quiet" onClick={() => { setMemberPopoverId(null); onOpenReport(target.id); }}>看汇报</button>}
        </div>;
      })()}
    </div>}
    <div className="side-quick-cards">
      <button type="button" className="side-action-card is-sdd" onClick={() => setSddOpen(true)}>
        <span className="side-action-ico"><GitCompareArrows size={15} /></span>
        <span className="side-action-body">
          <span className="side-action-top">
            <strong>SDD · 双盲规范</strong>
            <span className={`side-sdd-stage stage-${sddSummary?.stage ?? 'idle'}`}>{sddStageLabel[sddSummary?.stage ?? 'idle'] ?? '未启动'}</span>
          </span>
          <span className="side-sdd-pills">
            <span className={sddSummary?.constitutionText ? 'on' : ''}>宪法{sddSummary?.constitutionText ? ' ✓' : ''}</span>
            <span className={sddSummary?.specText ? 'on' : ''}>Spec{sddSummary?.specCriteria?.length ? ` (${sddSummary.specCriteria.length})` : ''}</span>
            <span className={sddSummary?.planText ? 'on' : ''}>Plan</span>
            <span className={sddSummary?.tasksText ? 'on' : ''}>Tasks</span>
          </span>
        </span>
      </button>
      <button type="button" className="side-action-card is-fanout" onClick={() => setFanoutOpen(true)} title="让 2–3 位成员在独立副本并行盲写代码，对比 Diff 后一键采纳 (Ctrl+Shift+F)">
        <span className="side-action-ico"><Sparkles size={15} /></span>
        <span className="side-action-body">
          <span className="side-action-top">
            <strong>并行盲写比稿</strong>
            <kbd>⇧F</kbd>
          </span>
          <small>独立副本写代码 · 横向 Diff 择优</small>
        </span>
      </button>
    </div>
  </div>;
  const dock = !data ? null : <FlowDock sunk={dockSunk} setSunk={setDockSunk} view={dockView} setView={setDockView} open={dockOpen} onToggle={setDockOpen} waiting={waiting} standing={standing}
    bodyRef={nextStepBody} action={fresh && !picking ? <button type="button" className="button small primary" disabled={busy || people.filter(ready).length < 2} title={people.filter(ready).length < 2 ? '至少需要两位已准备好的成员参加' : ''} onClick={() => { setPicking(true); setDockOpen(true); }}><Hand size={13} />立项 / 起草方案</button> : nextStep?<span className="flow-next-step" role="group" aria-label="项目下一步"><small>下一步</small><button type="button" className="button small primary" disabled={busy} onClick={nextStep.run}>{nextStep.label}</button></span>:undefined}>{items}</FlowDock>;

  /** Flow messages in the chat: what was posted and where it stands now; acting on it happens in the dock. */
  const renderFlow = (message: RoomMessage) => {
    if (!data) return undefined;
    if(message.roundtable)return <FlowMessage title="圆桌带回的材料" status="已保存引用" pending={false} text={message.text} headerAction={onRoundtable && <button className="link-button" onClick={()=>onRoundtable({topicId:message.roundtable!.topicId})}>打开圆桌议题</button>}/>;
    if(message.jointReview)return <FlowMessage title="历史共同评审结论" status="只读" pending={false} text={message.text}/>;
    let title = '', status = '', pending = false;
    if (message.flowPlan) { const summary = data.plans?.find(item => item.id === message.flowPlan!.planId) ?? (data.plan?.id === message.flowPlan.planId ? data.plan : undefined); title = `方案 · 第 ${message.flowPlan.version} 版`; status = summary ? PLAN_STATUS[summary.status] ?? summary.status : ''; pending = summary?.status === 'awaiting_confirmation' && summary.id === flow?.activePlanId; }
    else if (message.flowDecision) { const decision = data.decisions.find(item => item.id === message.flowDecision!.decisionId); title = decision ? `决策 · ${decision.title}` : '决策'; pending = message.flowDecision.status === 'open' && decision?.status === 'open'; status = message.flowDecision.status === 'open' ? (pending ? '待你决定' : decision?.status === 'answered' ? '已处理' : '已过期') : message.author === 'user' ? '你的决定' : '已结束'; }
    else if (message.flowReport) { const round = data.rounds.find(item => item.id === message.flowReport!.roundId); title = round ? `第 ${round.index + 1} 轮 · ${round.title} · 汇报` : '轮次汇报'; pending = Boolean(round && actionable(round) && round.integrationId === message.flowReport.integrationId); status = round ? round.integrationId !== message.flowReport.integrationId ? '已被新的汇报替代' : ROUND_STATUS[round.status] : ''; }
    const detailId = message.flowDecision?.decisionId ?? message.flowReport?.roundId;
    const target = message.flowPlan ? '[data-flow-next="plan"]' : detailId ? `[data-flow-detail="${CSS.escape(detailId)}"]` : undefined;
    return <FlowMessage title={title} status={status} pending={pending} text={message.text} onOpen={target ? () => revealStep(target) : undefined}>{(message.flowPlan||message.flowReport)&&onRoundtable&&<button className="link-button" onClick={()=>onRoundtable(message.flowPlan?{planId:message.flowPlan.planId}:{integrationId:message.flowReport!.integrationId})}>送去圆桌评审</button>}{message.flowReport&&!pending&&<><button className="link-button" onClick={()=>void invoke<{title:string;markdown:string}>('projectFlow.round.report.export',{projectId:project.id,roundId:message.flowReport!.roundId}).then(r=>invoke('file.save',{name:r.title+'.md',content:r.markdown})).catch(e=>setError((e as Error).message))}>导出本轮汇报</button><RoundResults key={message.flowReport.integrationId} projectId={project.id} roundId={message.flowReport.roundId} integrationId={message.flowReport.integrationId} invoke={invoke}/></>}</FlowMessage>;
  };

  return <main className="project-room" aria-label={`${project.name} 的项目会议室`}>
    <header className="project-room-head">
      <span className="project-room-icon"><FolderOpen size={19} /></span>
      <div className="project-room-title"><h1>{project.name}<small>项目会议室</small></h1>{flow&&live&&data?.overview.stage?<p className="project-stage" aria-label="当前阶段" title={`${project.directory}
任务在独立副本中执行，验收后写回。`}>{currentRound && flow.status === 'active' && <strong>第 {currentRound.index + 1} 轮「{currentRound.title}」 · </strong>}{data.overview.stage.label} · 本轮负责人 <MemberName id={data.overview.stage.leadMemberId??flow.leadMemberId}/></p>:<p title={`${project.directory}
讨论只读；任务在独立副本中执行，验收后写回。`}>{project.directory}</p>}</div>
      {fresh&&flow&&<label className="project-record-setting"><input type="checkbox" checked={includePreviousRecord} onChange={e=>setIncludePreviousRecord(e.target.checked)}/>起草时参考上一段记录</label>}
      {flow && live && <div className="project-room-numbers" aria-label="本段工作进度">
        <span><strong>{data!.overview.working}</strong>在做</span><span><strong>{data!.overview.remaining}</strong>待完成</span>
        <span className={data!.overview.needsUser ? 'needs-user' : ''}><strong>{data!.overview.needsUser}</strong>待你决定</span></div>}
      {data&&(fresh||live)&&<label className="project-review-level">复核程度<select aria-label="项目复核程度" disabled={busy} value={fresh?newReviewLevel:reviewLevel(flow!)} title={`${REVIEW_LEVEL_HINTS[fresh?newReviewLevel:reviewLevel(flow!)]}
调整只影响尚未开始的复核，已完成和在途的复核记录保留。`} onChange={event=>{const level=event.target.value as ReviewLevel;if(fresh)setNewReviewLevel(level);else void mutate('projectFlow.review.configure',{flowId:flow!.id,expectedRevision:flow!.revision,reviewLevel:level},'复核程度已调整，已完成的记录保留。');}}>{(['high','medium','low'] as const).map(level=><option key={level} value={level}>{REVIEW_LEVEL_LABELS[level]}</option>)}</select></label>}
      {flow && live && <div className="project-room-controls">
        {flow.dispatchMode === 'running' && !canRetry
          ? <button type="button" className="button small secondary" disabled={busy || !allowed(data!.allowedActions, 'projectFlow.pause')} title="已在做的任务会做完并保存；之后不派新任务" onClick={() => void mutate('projectFlow.pause', { flowId: flow.id, expectedRevision: flow.revision, mode: 'dispatch' }, '已暂停派发新任务；在做的任务会做完。')}><Pause size={13} />暂停</button>
          : <button type="button" className="button small primary" disabled={busy || blocked.length > 0 || !allowed(data!.allowedActions, 'projectFlow.resume')} title={blocked.length ? '先处理卡住的尝试' : canRetry ? '继续会重试卡住的任务或复核' : flow.waitingForFirstRoundStart ? '启动已确认方案的第一轮' : '继续按计划派发；不会重发结果未知的运行'} onClick={() => void mutate('projectFlow.resume', { flowId: flow.id, expectedRevision: flow.revision }, '已继续派发。')}><Play size={13} />{flow.waitingForFirstRoundStart ? "启动第一轮" : "继续"}</button>}
        <button type="button" className="icon-button danger" aria-label="取消流程" title="取消流程（记录和成果保留）" disabled={busy} onClick={() => { if (window.confirm('取消这个项目流程？已有成果和记录会保留，在做的任务会停下。')) void mutate('projectFlow.cancel', { flowId: flow.id, expectedRevision: flow.revision }, '项目流程已取消，记录保留。'); }}><Square size={14} /></button>
      </div>}
    </header>
    <div className="project-room-subbar">
    {people.length>0&&<label className="project-review-level" title="项目常驻总负责人（固定不变，负责讨论控场与全局对接；每次立项或 SDD 可单独指定本轮负责人）">项目 Leader <MemberSelect aria-label="项目 Leader" value={project.meetingLeaderId??''} onChange={event=>void invoke('project.update',{projectId:project.id,memberIds:roster,meetingLeaderId:event.target.value||null}).catch(reason=>setError((reason as Error).message))}><option value="">暂未指定</option>{people.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</MemberSelect></label>}
    {live && <ol className="flow-steps" aria-label="流程进度">{STEPS.map((label, index) => <li key={label} className={index < step ? 'done' : index === step ? 'current' : ''} aria-current={index === step ? 'step' : undefined}>{index < step ? <Check size={11} /> : <span>{index + 1}</span>}{label}</li>)}
      {flow!.dispatchMode !== 'running' && <li className="paused">已暂停派发</li>}</ol>}
    {onOpenReport && <ReportSwitcher entries={reports} onOpen={onOpenReport} />}
    {parentProject&&fresh&&<button type="button" className="button small quiet" title="管理立项资料副本" disabled={busy} onClick={()=>setMaterials(true)}><FolderOpen size={13}/>资料</button>}
    {parentProject&&<button type="button" className="button small quiet" title="只读查看 ROOM_BRIEF.md 与 HANDOFF.md" onClick={()=>void invoke<StudyRoomDocuments|null>('projectFlow.study.documents',{projectId:project.id}).then(result=>{if(result)setStudyDocs(result);else setMissingStudy(project.id);}).catch(reason=>setError((reason as Error).message))}><ScrollText size={13}/>门牌</button>}
    <button type="button" className="button small quiet project-subbar-pill" title="命令面板 (Ctrl+K)" onClick={()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))}><Sparkles size={12}/>命令 <kbd>⌘K</kbd></button>
    </div>
    {missingStudy===project.id&&parentProject&&<Modal title="初始化任务房" subtitle={project.name} onClose={()=>{if(!busy)setMissingStudy(undefined);}}>
      <div className="modal-body"><p>补齐 00–03 目录、房间门牌、交接日志和讨论白板。已存在的文件会保留。</p>{error&&<p role="alert">{error}</p>}</div>
      <div className="modal-footer"><button type="button" className="button quiet" disabled={busy} onClick={()=>setMissingStudy(undefined)}>取消</button><button type="button" className="button primary" disabled={busy} onClick={()=>void initializeRoom()}>初始化任务房</button></div>
    </Modal>}
    {materials&&parentProject&&<ProjectMaterialsModal project={project} parent={parentProject} invoke={invoke} onClose={()=>setMaterials(false)}/>}
    {sddOpen&&<SddModal project={project} snapshot={snapshot} roster={roster} reviewLevel={fresh?newReviewLevel:reviewLevel(flow!)} invoke={invoke} onClose={()=>setSddOpen(false)} onLaunched={()=>void load()}/>}
    {fanoutOpen&&<FanoutModal project={project} snapshot={snapshot} roster={roster} invoke={invoke} onClose={()=>setFanoutOpen(false)} onAdopted={()=>{setBoardView('code');}}/>}
    {studyDocs&&<Modal title={studyDocs.name+' · 房间文件'} subtitle="只读查看，不会改文件或触发派工。" onClose={()=>setStudyDocs(null)}><div className="modal-body study-room-documents"><details open><summary>ROOM_BRIEF.md · 门牌</summary><pre>{studyDocs.brief}</pre></details><details open><summary>HANDOFF.md · 交接</summary><pre>{studyDocs.handoff}</pre></details></div>{parentProject&&fresh&&<div className="modal-footer"><button className="button small secondary" type="button" disabled={busy} onClick={()=>void initializeRoom()}>补齐任务房结构</button></div>}</Modal>}
    {error && <p className="inline-notice error" role="alert">{error}<button type="button" className="icon-button" aria-label="关闭提示" title="关闭提示" onClick={() => setError('')}><X size={12} /></button></p>}
    {rounds.filter(round=>round.studyHandoffError).map(round=><p key={round.id} className="inline-notice error" role="status">等交接：{round.title} · {round.studyHandoffError} <button type="button" className="button small secondary" disabled={busy} onClick={()=>void invoke<{error?:string}>('projectFlow.study.handoff.retry',{projectId:project.id,roundId:round.id}).then(result=>{if(result.error)setError(result.error);void load();}).catch(reason=>setError((reason as Error).message))}>重新写入交接</button></p>)}
    {data?.taskAdditions?.map(proposal=><p key={proposal.id} className="inline-notice" role="status"><button className="button small secondary" aria-label={'查看待确认追加：'+proposal.title} onClick={()=>setAddition({memberId:proposal.memberId,goal:proposal.goal,proposal})}>{proposal.status==='preparing'?'查看正在准备的追加任务':proposal.status==='blocked'?'查看未完成的追加任务':'查看待确认追加任务'}：{proposal.title}</button></p>)}
    {snapshot.workLogFailures?.filter(r=>r.projectId===project.id).map(r=><p key={r.roundId} className="task-meta bad" role="status">成果已经验收，工作日志保存失败。<button className="link-button" onClick={()=>setLogTarget({kind:'round',id:r.roundId})}>查看日志并重试</button></p>)}
    {!data ? <div className="project-room-loading"><LoaderCircle size={16} className="spin" />正在打开会议室…</div> : <div className={`project-room-grid ${boardOpen||activeDocument?'panel-resizable':'board-collapsed'}`} style={panelWidth.style}>
      <RoomView snapshot={snapshot} invoke={invoke} roomId={roomId} focus={roomFocus} onDocument={target => setDocument({projectId: project.id, target})} onOpenSession={(_, sessionId) => setLogTarget({kind:'session',id:sessionId})}
        project={{ roster, onRoster: changeRoster, renderFlow, dock, onTaskRequest:async(memberId,goal,mode)=>{if(!flow||flow.status!=='active'){setError('先确认方案后再安排或补充任务。');return false;}const task=mode==='supplement'?(tasks.find(t=>t.memberId===memberId&&['running','correcting'].includes(t.status))??tasks.find(t=>t.memberId===memberId&&['pending','ready','queued','awaiting_review'].includes(t.status))):undefined;if(mode==='supplement'&&!task){setError('该成员暂无可补充任务，请安排新任务。');return false;}setAddition({memberId,goal,...(task?{task}:{})});return true;}, onConfigureMember:memberId=>{setConfig({memberId,value:project.memberConfigs?.[memberId]??{},revision:project.memberConfigRevision??0});setConfigError('');},
          flowNextStep: Boolean(dock && ((fresh && !picking) || nextStep)),
          empty: <div className="room-empty project-room-empty"><div className="room-empty-team">{people.map(member => <Avatar key={member.id} member={member} size={48} />)}</div><h2>这次想一起做什么？</h2><p>先在这里说说目标、范围和要求，大家会一起讨论。讨论清楚后，在输入框上方选负责人起草方案。</p></div> }} />
      {(boardOpen||activeDocument)&&panelWidth.separator}
      {activeDocument?<ProjectDocument selection={activeDocument} invoke={invoke} onClose={()=>setDocument(undefined)}/>:!boardOpen?<aside className="project-side-rail" aria-label="看板已收起"><button type="button" className="icon-button" aria-label="展开看板" title="展开看板" onClick={()=>toggleBoard(true)}><PanelRightOpen size={16}/></button><button type="button" className="project-side-rail-label" onClick={()=>toggleBoard(true)}>看板</button>{data.overview.needsUser>0&&<span className="project-side-rail-count" title={`${data.overview.needsUser} 项待你决定`}>{data.overview.needsUser}</span>}</aside>:
      <div className="project-side">
        <div className="project-side-bar">
          <div className="segmented side-segmented-icons" role="tablist" aria-label="项目工作台视图">
            <button type="button" role="tab" aria-selected={boardView==='work'} className={boardView==='work'?'selected':''} onClick={()=>setBoardView('work')}><LayoutList size={13}/><span>工作</span></button>
            <button type="button" role="tab" aria-selected={boardView==='code'} className={boardView==='code'?'selected':''} onClick={()=>setBoardView('code')}><GitBranch size={13}/><span>代码</span></button>
            <button type="button" role="tab" aria-selected={boardView==='terminal'} className={boardView==='terminal'?'selected':''} onClick={()=>setBoardView('terminal')} title="交互终端与成员 CLI (Ctrl+J)"><Terminal size={13}/><span>终端</span></button>
            <button type="button" role="tab" aria-selected={boardView==='progress'} className={boardView==='progress'?'selected':''} onClick={()=>setBoardView('progress')}><History size={13}/><span>历史</span></button>
          </div>
          <span className="project-side-tools">
            <button type="button" className="icon-button" aria-label="收起看板" title="收起右侧栏 (Ctrl+B)" onClick={()=>toggleBoard(false)}><PanelRightClose size={15}/></button>
          </span>
        </div>
      {boardView==='progress'?<ProjectProgressView project={project} snapshot={snapshot} invoke={invoke}/>:boardView==='terminal'?<WorkspaceTerminalPanel project={project} roomId={roomId} roster={roster} invoke={invoke} focusTerminalId={focusTerminalId}/>:boardView==='code'?<WorkspaceCodePanel project={project} roomId={roomId} roster={roster} invoke={invoke} scriptsOpen={false} onToggleScripts={()=>setBoardView('terminal')} onOpenDocument={(rel, edit)=>setDocument({projectId:project.id,target:rel,edit})} checkpointTrigger={checkpointTrigger}/>:<div className="side-workspace">{sideHeaderSummary}<Board focusedTask={focusedTask} invoke={invoke} rounds={rounds} tasks={tasks} data={data} snapshot={snapshot} busy={busy} blocked={blocked} resultUnknown={resultUnknown} onGiveUp={giveUp} onContinue={(op,evidence)=>resolveAttempt(op,'continue',evidence)} members={repairMembers.filter(member => flow?.memberIds.includes(member.id))} onLog={setLogTarget} onOpenSdd={() => setSddOpen(true)}
        onReassign={reassign} /></div>}
      </div>}
    </div>}
    {logTarget&&<WorkLog key={project.id+logTarget.kind+logTarget.id} project={project} target={logTarget} invoke={invoke} onClose={()=>setLogTarget(null)}/>}
    {addition&&data&&<TaskAdditionView data={data} memberId={addition.memberId} initialGoal={addition.goal} supplementTask={addition.task} initialProposal={addition.proposal} invoke={invoke} onClose={()=>setAddition(null)} onDone={()=>void load()}/>}
    {config&&team.get(config.memberId)&&<Modal title={team.get(config.memberId)!.name+' 的项目配置'} subtitle="只在这个项目使用；人物卡默认设置不变。" onClose={()=>{if(!configBusy)setConfig(null);}}>
      <div className="modal-body"><MemberConfigFields snapshot={snapshot} member={team.get(config.memberId)!.card} value={config.value} invoke={invoke} onChange={value=>setConfig({...config,value})}/>
        <MemberRunConfig snapshot={snapshot} project={project} memberId={config.memberId}/>{configError&&<p role="alert" className="task-meta bad">{configError}</p>}</div>
      <div className="modal-footer"><button className="button quiet" disabled={configBusy} onClick={()=>setConfig(null)}>取消</button><button className="button primary" disabled={configBusy} onClick={()=>{setConfigBusy(true);void invoke('project.update',{projectId:project.id,memberConfigs:{[config.memberId]:config.value},expectedConfigRevision:config.revision},'已保存项目配置。').then(()=>setConfig(null)).catch(e=>setConfigError((e as Error).message)).finally(()=>setConfigBusy(false));}}>保存</button></div>
    </Modal>}
  </main>;
}

const PLAN_STATUS: Record<string, string> = { awaiting_confirmation: '待你确认', confirmed: '已确认', superseded: '已被新版替代', draft: '草稿' };
/** A plan, decision or report as posted in the chat. Settled ones fold to their title line so the conversation reads
 *  through; one that waits for the owner shows its text and opens the dock where it is handled. */
function FlowMessage({ title, status, pending, text, onOpen, children, headerAction }: { title: string; status: string; pending: boolean; text: string; onOpen?: () => void; children?:ReactNode; headerAction?:ReactNode }) {
  const body = text.replace(/^【[^】]*】\s*/, ''), long = body.length > 280 || body.split('\n').length > 6;
  const [open, setOpen] = useState(pending && !long);
  useEffect(() => { if (pending) setOpen(!long); }, [pending]);
  return <article aria-label={title} className={`flow-message ${pending ? 'pending' : 'settled'} ${open ? 'open' : ''}`}>
    <header><button type="button" className="flow-message-title" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<strong>{title}</strong></button>{status && <span className="flow-message-status">{status}</span>}{pending && onOpen && <button type="button" className="link-button" onClick={onOpen}>去处理</button>}{headerAction}</header>
    {open && <div className="flow-message-text"><Markdown text={body} />{children}</div>}
  </article>;
}

/** What waits for the owner, floating over the bottom of the chat: one line when folded, the cards when open.
 *  Open, it can also fill the whole chat area or move into its own window for long plans and reports. */
function FlowDock({ open, onToggle, waiting, standing, action, children,bodyRef, view, setView, sunk, setSunk }: { sunk: boolean; setSunk: (value: boolean) => void; view: 'dock' | 'full' | 'window'; setView: (view: 'dock' | 'full' | 'window') => void; open: boolean; onToggle: (open: boolean) => void; waiting: string[]; standing: string[]; action?: ReactNode; children: ReactNode;bodyRef?:Ref<HTMLDivElement> }) {
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startHeight: number; maximum: number } | undefined>(undefined);
  const [height, setHeight] = useState<number>();
  const title = waiting.length ? '待你处理' : '进展';

  function sizeLimits() {
    const current = panelRef.current?.getBoundingClientRect().height ?? 180;
    const messages = panelRef.current?.closest('.room')?.querySelector('.room-messages');
    return { current, maximum: current + (messages?.getBoundingClientRect().height ?? 0) };
  }

  function resizePanel(next: number, maximum: number) {
    if (next >= maximum - 24) {
      setView('full');
      return;
    }
    if (next <= 44) {
      resetHeight();
      onToggle(false);
      setSunk(true);
      return;
    }
    if (next <= 78) {
      resetHeight();
      onToggle(false);
      return;
    }
    setView('dock');
    setHeight(Math.max(80, Math.round(next)));
  }

  function resetHeight() {
    setHeight(undefined);
    setView('dock');
  }
  function sinkToBottom() {
    resetHeight();
    onToggle(false);
    setSunk(true);
  }
  const body = <div className="flow-dock-body" ref={bodyRef}>{children}</div>;
  if (sunk && view !== 'window') {
    return <div className="flow-dock-sunk-wrap">
      <button type="button" className={`flow-dock-pill ${waiting.length ? 'has-waiting' : ''}`} title="展开待你处理" onClick={() => { setSunk(false); onToggle(true); }}>
        <ChevronUp size={13} /><span>{title}</span>{waiting.length > 0 && <span className="flow-dock-count">{waiting.length}</span>}
      </button>
    </div>;
  }
  return <>
    <section ref={panelRef} style={open && view === 'dock' && height !== undefined ? { maxHeight: `min(${height}px, calc(100cqh - 160px))`, height } : undefined} className={`flow-dock ${open ? 'open' : ''} ${open && view === 'full' ? 'full' : ''} ${waiting.length ? 'has-waiting' : ''}`} aria-label="待你处理">
      {open && view !== 'window' && <div
        className="flow-dock-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label="调整待你处理高度"
        title="上下拖动调整高度，双击还原。方向键调整，Home 还原，End 铺满。"
        onPointerDown={event => {
          if (event.button !== 0) return;
          const { current, maximum } = sizeLimits();
          drag.current = { startY: event.clientY, startHeight: current, maximum };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={event => {
          if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const { startY, startHeight, maximum } = drag.current;
          resizePanel(startHeight + startY - event.clientY, maximum);
        }}
        onLostPointerCapture={() => { drag.current = undefined; }}
        onDoubleClick={resetHeight}
        onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          if (event.key === 'Home') resetHeight();
          else if (event.key === 'End') setView('full');
          else {
            const { current, maximum } = sizeLimits();
            resizePanel(current + (event.key === 'ArrowUp' ? 36 : -36), maximum);
          }
        }}
      ><span /></div>}
      <div className="flow-dock-bar">
        <button type="button" className="flow-dock-toggle" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}会议待办：${(waiting.length ? waiting : standing).join('、')}`} title={open ? '收起，回到聊天' : '展开待处理的事项'} onClick={() => { if (open) resetHeight(); onToggle(!open); }}>
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}<strong>{title}</strong>{waiting.length > 0 && <span className="flow-dock-count">{waiting.length}</span>}
          {/* Folded, the bar says what waits; open, the cards below say it, so the line is not repeated. */}
          <span className="flow-dock-summary">{open ? '' : (waiting.length ? waiting : standing).join(' · ')}</span>
        </button>
        {action}
        {open && view === 'dock' && height !== undefined && <button type="button" className="button small quiet" onClick={resetHeight}>还原高度</button>}
        {view !== 'window' && <button type="button" className="icon-button" aria-label={view === 'full' && open ? '还原到聊天框上方' : '铺满聊天区查看'} title={view === 'full' && open ? '还原到聊天框上方' : '铺满聊天区查看'} onClick={() => { if (view === 'full' && open) resetHeight(); else setView('full'); onToggle(true); }}>{view === 'full' && open ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>}
        {view !== 'window' && <button type="button" className="icon-button" aria-label="沉底隐藏" title="完全沉底，不挡聊天" onClick={sinkToBottom}><ChevronsDown size={14} /></button>}
        <button type="button" className="icon-button" aria-label={view === 'window' ? '收回到聊天框上方' : '在独立窗口查看'} title={view === 'window' ? '收回到聊天框上方' : '在独立窗口查看'} onClick={() => { setView(view === 'window' ? 'dock' : 'window'); onToggle(true); }}><AppWindow size={14} /></button>
      </div>
      {open && view !== 'window' && body}
    </section>
    {open && view === 'window' && createPortal(<Modal title={title} subtitle="在这里处理与在聊天框上方处理相同；关闭后回到原位置。" className="flow-dock-modal" onClose={() => setView('dock')}>{body}</Modal>, document.body)}
  </>;
}

function MeetingHud({ members, leadId, round, tasks, pendingPlan, speaking, ready, onTask, onRound, onPlan, onReport }: {
  members: TeamMember[];
  leadId?: string;
  round?: Round;
  tasks: Task[];
  pendingPlan?: Plan;
  speaking?: string;
  ready: (member: TeamMember) => boolean;
  onTask: (task: Task) => void;
  onRound: (round: Round) => void;
  onPlan: () => void;
  onReport?: (memberId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [memberDetails, setMemberDetails] = useState<string>();
  const selected = members.find(member => member.id === memberDetails);
  const firstPlannedRound = pendingPlan?.rounds[0];
  const currentTasks = tasks.filter(task => task.roundId === round?.id);
  const queued = currentTasks.filter(task => task.status === 'queued');
  const supplements = currentTasks.flatMap(task => (task.supplements ?? [])
    .filter(item => item.status === 'pending' && item.delivery === 'next-turn')
    .map(item => ({ task, item })));
  const priority = ['blocked', 'escalated', 'running', 'correcting', 'awaiting_review', 'queued', 'ready', 'pending'];
  const selection = selected && {
    planned: pendingPlan?.tasks.filter(item => item.memberId === selected.id) ?? [],
    assigned: currentTasks.filter(item => item.memberId === selected.id || item.reviewerMemberId === selected.id && item.status === 'awaiting_review'),
  };
  function open(read: () => void) {
    setExpanded(false);
    setMemberDetails(undefined);
    read();
  }
  const board = <section className="meeting-hud" aria-label="会议实时看板">
    <header>
      <strong>会议实时看板</strong>
      {!expanded && <button type="button" className="link-button meeting-hud-expand" onClick={() => setExpanded(true)}><Maximize2 size={13} />展开看板</button>}
      {firstPlannedRound ? <button type="button" className="link-button" onClick={() => open(onPlan)}>第 1 轮 · {firstPlannedRound.title} · 待审批</button> : round && <button type="button" className="link-button" onClick={() => open(() => onRound(round))}>
        第 {round.index + 1} 轮 · {round.title} · {ROUND_STATUS[round.status]}
      </button>}
    </header>
    <div className="meeting-hud-members">
      {members.map(member => {
        const task = priority.map(status => currentTasks.find(item => item.status === status &&
          (status === 'awaiting_review' ? item.reviewerMemberId : item.memberId) === member.id)).find(Boolean);
        const planned = firstPlannedRound && pendingPlan?.tasks.find(item => item.roundKey === firstPlannedRound.key && item.memberId === member.id);
        const offline = !ready(member);
        const talking = speaking === member.id;
        const label = talking ? '会议发言中' : offline ? '连接未就绪' : planned ? '待审批' : task ? TASK_STATUS[task.status] : '待命';
        const detail = planned?.title ?? (task?.blockedReason ? plainFlowError(task.blockedReason) : task?.title);
        const content = <><Avatar member={member} size={25} ring={false} /><span><strong>{member.name}{leadId === member.id && <small>Leader</small>}</strong>
          <span className="meeting-hud-member-status">{label}</span>{detail && <small className="meeting-hud-detail">{detail}</small>}</span></>;
        const tone = offline || task?.status === 'blocked' || task?.status === 'escalated' ? 'blocked'
          : talking || task?.status === 'running' || task?.status === 'correcting' ? 'working' : 'waiting';
        const className = 'meeting-hud-member tone-' + tone;
        return planned || task || onReport ? <button type="button" key={member.id} className={className}
          title={detail ?? (member.name + '的项目汇报')}
          aria-label={member.name + (leadId === member.id ? ' Leader' : '') + ' · ' + label + ' · 查看详情'}
          onClick={() => setMemberDetails(member.id)}>{content}</button>
          : <div key={member.id} className={className}>{content}</div>;
      })}
    </div>
    <div className="meeting-hud-queue" aria-label="交棒队列">
      <strong>交棒队列 · {queued.length + supplements.length}</strong>
      {!queued.length && !supplements.length && <span>{pendingPlan ? '审批后才入队' : round ? '当前没有已入队的交棒' : '待安排本轮任务'}</span>}
      {queued.map(task => <button key={task.id} type="button" className="link-button" onClick={() => open(() => onTask(task))}>
        等 <MemberName id={task.memberId} /> 接手 · {task.title}
      </button>)}
      {supplements.map(({ task, item }) => <button key={item.id} type="button" className="link-button" onClick={() => open(() => onTask(task))}>
        等 <MemberName id={task.memberId} /> 下一次执行 · {task.title}的补充要求
      </button>)}
    </div>
  </section>;
  const details = selected && selection && <div className="modal-body meeting-hud-details">
    {[...selection.planned.map(task => ({ key: task.key, task, roundName: pendingPlan?.rounds.find(item => item.key === task.roundKey)?.title, status: '待审批' })),
      ...selection.assigned.map(task => ({ key: task.id, task, roundName: round?.title, status: TASK_STATUS[task.status] }))
    ].map(({ key, task, roundName, status }) => <article key={key} className="meeting-hud-assignment">
      <p className="task-meta">{[roundName, status].filter(Boolean).join(' · ')}</p>
      <h3>{task.title}</h3>
      {task.goal && <Markdown text={task.goal} />}
      {task.inputs.length > 0 && <><h4>输入</h4><ul>{task.inputs.map((input, index) => <li key={index}>{input}</li>)}</ul></>}
      {task.completionCriteria.length > 0 && <><h4>完成标准</h4><ul>{task.completionCriteria.map((item, index) => <li key={index}>{renderInlineMd(criterionText(item))}</li>)}</ul></>}
      {task.allowedPaths.length > 0 && <><h4>允许修改</h4><ul>{task.allowedPaths.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
      {'id' in task && task.blockedReason && <p className="task-meta bad">{plainFlowError(task.blockedReason)}</p>}
      {'id' in task && <button type="button" className="link-button" onClick={() => open(() => onTask(task))}>打开任务看板</button>}
    </article>)}
    {!selection.planned.length && !selection.assigned.length && <p>本轮暂无分工。</p>}
    <div className="meeting-hud-detail-actions">
      {selection.planned.length > 0 && <button type="button" className="button secondary" onClick={() => open(onPlan)}>查看完整方案</button>}
      {onReport && <button type="button" className="button secondary" onClick={() => open(() => onReport(selected.id))}>查看成员汇报</button>}
    </div>
  </div>;
  const dialog = selected ? <Modal key={selected.id} title={selected.name + ' · 完整分工'} className="meeting-hud-modal" onClose={() => setMemberDetails(undefined)}>{details}</Modal>
    : expanded ? <Modal key="hud-overview" title="完整会议看板" className="meeting-hud-modal" onClose={() => setExpanded(false)}><div className="modal-body">{board}</div></Modal>
    : null;
  return <>{!expanded && board}{dialog && createPortal(dialog, document.body)}</>;
}

function MemberName({ id }: { id: string }) {
  const member = useTeam().get(id);
  return <span className={`flow-member member-${id}`}>{member && <Avatar member={member} size={18} ring={false} />}{member?.name ?? '成员'}</span>;
}
function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) { return <div className="meeting-note">{icon}<div>{children}</div></div>; }
/** A member speaking in the room: avatar, name and what they brought, the way the 茶歇室 shows a member's message. */
function MemberLine({ id, label, children }: { id: string; label?: ReactNode; children: ReactNode }) {
  const member = useTeam().get(id);
  return <div className={`meeting-line member-${id}`}>{member && <Avatar member={member} size={32} />}<div className="meeting-line-body"><span className="meeting-line-name"><strong>{member?.name ?? '成员'}</strong>{label}</span>{children}</div></div>;
}

/** Sent as the plan topic when resuming a task workspace task; the backend also hands the planner ROOM_BRIEF and HANDOFF. */
const RESUME_TOPIC = '接续本房间 ROOM_BRIEF.md 记录的当前阶段与下一棒：已验收的阶段不重做；先核对 HANDOFF.md 最新交接与实际文件，再只为剩余阶段起草方案。门牌中标明由用户本人完成的部分（如学术诚信要求亲手完成的代码与报告正文）只能安排核对、说明或复核，不得代写。'

function LeadPicker({ team, initialLead, ready, busy, onOrderChange, onStart, onCancel }: { team: TeamMember[]; initialLead?:string; ready: (member: TeamMember) => boolean; busy: boolean; onOrderChange?: (ids: string[]) => void; onStart: (lead: string, members: string[], topic?: string) => Promise<void>; onCancel: () => void }) {
  const [order, setOrder] = useState<string[]>(() => team.map(m => m.id));
  useEffect(() => {
    const incoming = team.map(m => m.id);
    setOrder(prev => {
      const kept = prev.filter(id => incoming.includes(id));
      const added = incoming.filter(id => !kept.includes(id));
      return [...kept, ...added];
    });
  }, [team.map(m => m.id).join(',')]);
  const orderedTeam = order.map(id => team.find(m => m.id === id)).filter((m): m is TeamMember => Boolean(m));
  const available = orderedTeam.filter(ready), [lead, setLead] = useState(initialLead??''), [note, setNote] = useState(''), leader = available.find(member => member.id === lead);
  const pickLead = (id: string) => {
    setLead(id);
    // Put selected Leader at position #1 by default; user can still adjust speaking order with ← / →.
    const next = [id, ...order.filter(item => item !== id)];
    setOrder(next);
    onOrderChange?.(next);
  };
  const shiftOrder = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    onOrderChange?.(next);
  };
  return <section className="lead-picker" aria-label="选负责人与发言顺位">
    <strong>谁来当负责人？</strong><small>点头像选负责人（默认排第 1 位发言），也可用下方 ← / → 自由调整本项目开会顺位；负责人自己做的任务由另一位复核。</small>
    <div className="lead-picker-members">{orderedTeam.map((member, index) => {
      const ok = ready(member);
      return <div key={member.id} className={`lead-option member-${member.id} on ${lead === member.id ? 'lead' : ''} ${ok ? '' : 'unready'}`}>
        <button type="button" className="lead-option-face" aria-label={`${member.name} 当负责人`} aria-pressed={lead === member.id} disabled={!ok || busy} title={ok ? '' : `${member.product} 还没准备好`} onClick={() => pickLead(member.id)}><Avatar member={member} size={42} />{lead === member.id && <span className="lead-badge">负责人</span>}</button>
        <span>{member.name}</span>
        <div className="lead-order-bar" aria-label={`${member.name} 发言顺位第 ${index + 1} 位`}>
          <button type="button" className="lead-order-btn" disabled={busy || index === 0} title="提前一位发言" onClick={() => shiftOrder(index, -1)}>←</button>
          <span className="lead-order-num">#{index + 1}</span>
          <button type="button" className="lead-order-btn" disabled={busy || index === orderedTeam.length - 1} title="靠后一位发言" onClick={() => shiftOrder(index, 1)}>→</button>
        </div>
      </div>;
    })}</div>
    <div className="round-actions"><button type="button" className="button primary" disabled={busy || available.length < 2 || !leader} onClick={() => void onStart(lead, available.map(member => member.id), note)}>{busy ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}{leader ? `请 ${leader.name} 起草方案` : '先选一位负责人'}</button><button type="button" className="button quiet" disabled={busy} onClick={onCancel}>再聊聊</button></div>
    <textarea className="lead-picker-note" rows={2} value={note} disabled={busy} aria-label="补充起草细则和要求" placeholder="补充起草细则、要求、分工偏好或截止时间（可选，留空按刚才的讨论起草）…" onChange={event => setNote(event.target.value)} />
  </section>;
}

/** A revised plan names what changed against the version it replaces, so the owner can check the request landed. */
function PlanChanges({ plan, invoke }: { plan: Plan; invoke: Invoke }) {
  const team = useTeam(), [changes, setChanges] = useState<{ version: number; items: string[] } | null>(null);
  useEffect(() => {
    let alive = true; setChanges(null);
    if (plan.parentPlanId) void invoke<Plan>('projectFlow.detail', { projectId: plan.projectId, kind: 'plan', id: plan.parentPlanId }, undefined, { background: true })
      .then(parent => { if (alive) setChanges({ version: parent.version, items: planChanges(parent, plan, id => team.get(id)?.name ?? id) }); }).catch(() => {});
    return () => { alive = false; };
  }, [plan.id, plan.parentPlanId]);
  if (!changes) return null;
  return <div className="plan-changes" aria-label={`和第 ${changes.version} 版相比`}><h4>和第 {changes.version} 版相比</h4>{changes.items.length ? <ul>{changes.items.map(item => <li key={item}>{item}</li>)}</ul> : <p>内容没有变化。</p>}</div>;
}
function normalizePlanMarkdown(raw: string): string {
  if (!raw) return '';
  let text = raw.replace(/\r\n/g, '\n').trim();
  // Restore collapsed headings (e.g. "...。 ### 标题" -> "...。\n\n### 标题")
  text = text.replace(/([^\n])\s+(#{2,4}\s+)/g, '$1\n\n$2');
  // Restore collapsed bullet points (e.g. "： - **xxx**" or "； - **xxx**")
  text = text.replace(/([：:；;。])\s+-\s+(?=\*\*|`|\S)/g, '$1\n- ');
  // Restore numbered sections like "1. **xxx**" when glued after a sentence
  text = text.replace(/([。；;])\s+(\d+\.\s+\*\*)/g, '$1\n\n$2');
  return text;
}

function planHeadline(objective: string, version: number): string {
  const first = objective
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
    .find(Boolean) ?? `方案第 ${version} 版`;
  return first.length > 72 ? `${first.slice(0, 72)}…` : first;
}

function PlanCard({ plan, invoke, lead, rounds, busy, onConfirm, onRevise,defaultLevel,onRoundLevel }: { plan: Plan; invoke: Invoke; lead: string; rounds: Round[]; busy: boolean;defaultLevel:ReviewLevel;onRoundLevel:(round:Round,level:ReviewLevel)=>Promise<boolean>; onConfirm: (choices: Record<string, boolean>,peerChoices:Record<string,boolean>,levels:Record<string,ReviewLevel>,mode:NonNullable<Plan['studyContinuation']>,waitForFirstRoundStart:boolean) => Promise<boolean>; onRevise: (instruction: string) => Promise<boolean> }) {
  const toRoundtable=useRoundtableNavigation();
  const [revision, setRevision] = useState<string | null>(null);
  const waiting = plan.status === 'awaiting_confirmation';
  const [peerChoices,setPeerChoices]=useState<Record<string,boolean>>({}),[levels,setLevels]=useState<Record<string,ReviewLevel|'inherit'>>({});
  // Open while it waits for the owner; once confirmed it folds to its title so the rounds come into view.
  const [open, setOpen] = useState(waiting), [choices, setChoices] = useState<Record<string, boolean>>({});
  const [mode,setMode] = useState<NonNullable<Plan['studyContinuation']>>('manual');
  const [waitForFirstRoundStart,setWaitForFirstRoundStart] = useState(false);
  const automatic = mode === 'authorized';
  const leaderAssigned = plan.tasks.some(task=>task.memberId===lead);
  const ownerAccepts = (key:string) => choices[key] ?? !automatic;
  useEffect(() => { setChoices({});setLevels({});setPeerChoices({});setMode('manual');setWaitForFirstRoundStart(false); }, [plan.id]);
  useEffect(() => { setOpen(waiting); }, [plan.id, waiting]);
  const last = plan.rounds.at(-1)?.key, state = (key: string) => rounds.find(round => round.key === key);
  const label = <span className={`plan-status status-${plan.status}`}>方案第 {plan.version} 版 · {waiting ? '等你确认' : plan.status === 'confirmed' ? '已确认' : plan.status === 'superseded' ? '已被新版替代' : '草稿'}</span>;
  return <MemberLine id={lead} label={label}>
    <article className={`meeting-card plan-card ${waiting ? 'waiting' : ''}`} aria-label={`方案第 ${plan.version} 版`}>
      <div className="plan-card-header-row">
        <button type="button" className="plan-card-title" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<strong>{planHeadline(plan.objective, plan.version)}</strong></button>
        {toRoundtable&&<button className="link-button" onClick={()=>toRoundtable({projectId:plan.projectId,planId:plan.id})}>送去圆桌评审方案</button>}
      </div>
      {open && <>
        <div className="plan-md-body"><Markdown text={normalizePlanMarkdown(plan.objective)} /></div>
        {plan.scope && <div className="plan-scope plan-md-body"><Markdown text={normalizePlanMarkdown(plan.scope)} /></div>}
        {waiting && <div className="plan-scope">
          <label>推进方式 <select value={mode} aria-label="task workspace 推进方式" disabled={busy} onChange={event=>{setMode(event.target.value==='authorized'?'authorized':'manual');setChoices({});}}><option value="manual">逐轮手动确认</option><option value="authorized">按授权自动推进</option></select></label>
          <p>{automatic ? `方案确认后，只有证据齐全且下一轮完全按原计划时才自动接棒，每版最多 ${STUDY_AUTO_ROUND_LIMIT} 次。范围变化、未解决问题和最终验收仍等你。` : '每轮进入下一轮前等你确认。最终验收始终由你决定。'}</p>
          <label className="plan-accept"><input type="checkbox" checked={waitForFirstRoundStart} disabled={busy} onChange={event=>setWaitForFirstRoundStart(event.target.checked)} />确认方案后等我启动第一轮</label>
          {!leaderAssigned && <p role="status">提示：负责人当前仅统筹协调、未单独认领任务，你可以直接确认开工，也可点「要改一下」补充。</p>}
        </div>}
        {plan.parentPlanId && <PlanChanges plan={plan} invoke={invoke} />}
        <div className="plan-columns"><div><h4>交付什么</h4><ul>{plan.deliverables.map(item => <li key={criterionText(item)}>{renderInlineMd(criterionText(item))}（{criterionKind(item)==='owner'?'你来定':criterionKind(item)==='judge'?'成员评价':'可核对'}）</li>)}</ul></div><div><h4>怎样算完成</h4><ul>{plan.acceptanceCriteria.map(item => <li key={criterionText(item)}>{renderInlineMd(criterionText(item))}（{criterionKind(item)==='owner'?'你来定':criterionKind(item)==='judge'?'成员评价':'可核对'}）</li>)}</ul></div></div>
        <ol className="plan-rounds">{plan.rounds.map((round, index) => {
          const isLast = round.key === last, live = state(round.key),selectedLevel=waiting?(automatic?'high':levels[round.key]??round.reviewLevel??'inherit'):live?.reviewLevel??'inherit',effective=selectedLevel==='inherit'?defaultLevel:selectedLevel,isLow=effective==='low';
          return <li key={round.key}><div className="plan-round-head"><strong>第 {index + 1} 轮 · {round.title}</strong>{live && live.status !== 'pending' && <span className={`round-chip status-${live.status}`}>{ROUND_STATUS[live.status]}</span>}
            {waiting ? <label className="plan-accept" title={isLast ? '最后一轮一定由你验收' : '不勾选：由 Leader 验收，不写回项目；是否启动下一轮取决于推进方式'}><input type="checkbox" checked={isLast || isLow || ownerAccepts(round.key)} disabled={isLast || isLow || busy} onChange={event => setChoices(previous => ({ ...previous, [round.key]: event.target.checked }))} />需要我验收</label>
              : <small className="plan-accept-note">{live?.requiresUserAcceptance??round.requiresUserAcceptance ? '你来验收' : '负责人自验'}</small>}</div>
            <Markdown text={round.goal} /><label className="plan-review-level">本轮复核程度<select aria-label={`第 ${index+1} 轮复核程度`} value={selectedLevel} disabled={busy||waiting&&automatic||!waiting&&(!live||live.status!=='pending'||Boolean(live.startedAt))} onChange={e=>{const level=e.target.value as ReviewLevel|'inherit';if(waiting)setLevels({...levels,[round.key]:level});else if(level!=='inherit'&&live)void onRoundLevel(live,level);}}><option value="inherit" disabled={!waiting}>沿用总设置</option>{(['high','medium','low'] as const).map(level=><option key={level} value={level}>{REVIEW_LEVEL_LABELS[level]}</option>)}</select></label>{isLow&&<small>本轮不自动检查，必须由你验收。</small>}{round.completionCriteria&&<ul>{round.completionCriteria.map(c=><li key={criterionText(c)}>轮次标准：{renderInlineMd(criterionText(c))}（{criterionKind(c)==='owner'?'你来定':criterionKind(c)==='judge'?'成员评价':'可核对'}）</li>)}</ul>}{waiting?<label className="plan-peer"><input type="checkbox" aria-label={`第 ${index+1} 轮整体结果也请他人复核`} checked={peerChoices[round.key]===true||plan.tasks.some(task=>task.roundKey===round.key&&task.memberId===lead)} disabled={busy||plan.tasks.some(task=>task.roundKey===round.key&&task.memberId===lead)} onChange={event=>setPeerChoices(previous=>({...previous,[round.key]:event.target.checked}))}/>本轮整体结果也请他人复核</label>:live?.requiresPeerReview&&<small>整轮另请其他成员复核</small>}
            <ul className="plan-tasks">{plan.tasks.filter(task => task.roundKey === round.key).map(task => <li key={task.key}><MemberName id={task.memberId} /><span>{task.title}</span>{task.reuse&&<small>拟沿用 {task.reuse}（后台核对后生效）</small>}{task.review&&<small>单独复核</small>}{task.dependencies.length > 0 && <small>等 {task.dependencies.map(key => plan.tasks.find(item => item.key === key)?.title ?? key).join('、')}</small>}{task.allowedPaths.length > 0 && <small className="plan-task-paths" title="这项任务只能修改这些文件或文件夹">可改：{task.allowedPaths.join('、')}</small>}{task.completionCriteria.length > 0 && <details className="plan-task-criteria"><summary>完成标准 {task.completionCriteria.length} 条</summary><ul>{task.completionCriteria.map(item => <li key={criterionText(item)}>{renderInlineMd(criterionText(item))}</li>)}</ul></details>}</li>)}</ul></li>;
        })}</ol>
        {(waiting || plan.status === 'confirmed') && <div className="round-actions plan-confirm">
          {waiting && <button type="button" className="button primary" disabled={busy || !allowed(plan.allowedActions, 'projectFlow.plan.confirm')} title={action(plan.allowedActions, 'projectFlow.plan.confirm')?.reason} onClick={() => void onConfirm(Object.fromEntries(plan.rounds.map(round => [round.key, round.key === last || (!automatic && (levels[round.key]??round.reviewLevel??defaultLevel)==='low') || ownerAccepts(round.key)])),peerChoices,Object.fromEntries(Object.entries(levels).filter((entry):entry is [string,ReviewLevel]=>entry[1]!=='inherit')),mode,waitForFirstRoundStart)}>{busy ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />}{busy ? '正在确认方案…' : waitForFirstRoundStart ? '确认方案，稍后启动' : '确认方案，开工'}</button>}
          {waiting && !busy && !allowed(plan.allowedActions, 'projectFlow.plan.confirm') && <small className="task-meta bad">{action(plan.allowedActions, 'projectFlow.plan.confirm')?.reason ?? '当前不可确认（若顶部显示「已暂停派发」，请先点右上角「继续」）'}</small>}
          {revision === null && <button type="button" className="button secondary" disabled={busy || !allowed(plan.allowedActions, 'projectFlow.plan.revise')} title={action(plan.allowedActions, 'projectFlow.plan.revise')?.reason ?? '写下意见，负责人会改出新的一版'} onClick={() => setRevision('')}>{waiting ? '要改一下' : '调整方案'}</button>}
        </div>}
        {revision !== null && <div className="plan-revise"><textarea rows={3} autoFocus aria-label="对方案的修改意见" placeholder={waiting ? '补充修改意见（可选），例如去掉第五条标准。' : '修改意见可选填；在做的任务会先做完，新方案需再次确认。'} value={revision} disabled={busy} onChange={event => setRevision(event.target.value)} />
          <div className="round-actions"><button type="button" className="button small primary" disabled={busy} onClick={() => void onRevise(revision.trim()).then(ok => { if (ok) setRevision(null); })}><Send size={13} />交给负责人改</button><button type="button" className="button small quiet" disabled={busy} onClick={() => setRevision(null)}>取消</button></div></div>}
      </>}
    </article>
  </MemberLine>;
}

function RoundCard({ round, lead, data, invoke, busy, onDecide, onRecover,onCheck }: { round: Round; lead: string; data: ProjectFlowSnapshot; invoke: Invoke; busy: boolean; onDecide: (round: Round, integration: Integration, verdict: 'pass' | 'reject', reason?: string) => Promise<boolean>; onRecover: (acceptanceId: string, revision: number, choice: 'reconcile' | 'continue') => Promise<boolean>;onCheck:(round:Round,integration:Integration,memberId:string)=>Promise<boolean> }) {
  const toRoundtable=useRoundtableNavigation();
  const integration = data.integrations.find(item => item.id === round.integrationId), acceptance = data.acceptances.find(item => item.id === round.acceptanceId);
  const [diff, setDiff] = useState<{ changes: { path: string; kind: string }[]; text: string } | null>(null), [rejecting, setRejecting] = useState<string | null>(null);
  const awaiting = round.status === 'awaiting_acceptance' && round.requiresUserAcceptance && integration?.status === 'ready';
  const holding = data.decisions.find(item => item.status === 'open' && item.roundId === round.id && ['review-choice', 'meeting-request', 'unresolved-review', 'replan', 'review-dispute'].includes(item.kind));
  const report = round.report ? reportForDisplay(round.report) : undefined,team=useTeam(),[checker,setChecker]=useState(lead),checks=(data.requestedChecks??[]).filter(c=>c.roundId===round.id&&c.integrationId===integration?.id&&c.status==='completed');
  async function showDiff() { if (diff) { setDiff(null); return; } if (!integration?.version) return; try { setDiff(await invoke('projectFlow.artifact.diff', { artifactId: integration.version.artifactId })); } catch {} }
  if (!report && !integration) return <Note icon={<Play size={14} />}>第 {round.index + 1} 轮「{round.title}」{ROUND_STATUS[round.status]}，进度看右边的看板。</Note>;
  const label = <span className={`round-chip status-${round.status}`}>第 {round.index + 1} 轮成品 · {round.status === 'awaiting_acceptance' && !round.requiresUserAcceptance ? '负责人自验中' : ROUND_STATUS[round.status]}</span>;
  return <MemberLine id={lead} label={label}>
    <article className={`meeting-card round-card status-${round.status} ${awaiting ? 'awaiting' : ''}`} aria-label={`第 ${round.index + 1} 轮成品`}>
      <small className="round-review-level">本轮实际复核：{REVIEW_LEVEL_LABELS[integration?.reviewLevel??round.effectiveReviewLevel??roundReviewLevel(data.flow!,round)]}{round.nextConfirmation?.automatic && ' · 按批准方案自动接棒'}</small><strong className="round-card-title">{round.title}{acceptance?.acceptedAt && <small>{dateTime(acceptance.acceptedAt)} {acceptance.requiresApply && acceptance.status==='accepted' ? '已完成验收' : '负责人自验通过，尚未写回'}</small>}</strong>
      {report ? <div className="round-report"><h4>这一轮完成了</h4><div className="round-report-summary"><Markdown text={readableContent(report.summary)}/></div>
        {report.replyNotes?.map(note=><p className="task-meta" key={note}>{note}</p>)}
        {report.deliverables.length > 0 && <p className="round-deliverables">{report.deliverables.map(item => <span key={item} className="round-file">{item}</span>)}</p>}
        {report.userDecisionNeeded && <p className="round-report-ask"><Hand size={13} />{renderInlineMd(report.userDecisionNeeded)}</p>}
        {report.remainingIssues.length > 0 && <><h4>还要注意</h4><ul>{report.remainingIssues.map(item => <li key={item}>{renderInlineMd(item)}</li>)}</ul></>}
        {report.nextRoundSummary && <><h4>接下来</h4><p>{renderInlineMd(report.nextRoundSummary)}</p></>}</div>
        : <p className="panel-muted">{integration?.checkSummary ? renderInlineMd(integration.checkSummary) : '正在整合检查，汇报好了会出现在这里。'}</p>}
      {integration && integration.conflicts.length > 0 && <div className="round-conflicts"><AlertTriangle size={14} />整合时有 {integration.conflicts.length} 处冲突，负责人会安排修正：<ul>{integration.conflicts.map(item => <li key={item.path}>{item.path}：{item.reason}</li>)}</ul></div>}
      {integration?.version&&toRoundtable&&<button className="link-button" onClick={()=>toRoundtable({projectId:round.projectId,integrationId:integration.id,version:integration.version})}>送去圆桌评审本轮成果</button>}
      {integration?.version&&<RoundResults key={integration.id+":"+acceptance?.status} projectId={round.projectId} roundId={round.id} integrationId={integration.id} invoke={invoke} defaultOpen={awaiting}/>}
      <details className="round-details"><summary>验证细节</summary>
      {report?.systemNotes?.map((note,index)=><p className="round-system-note" key={index}>{note.text}</p>)}
      {report?.validationSummary && <div className="round-validation">{report.validationSummary.split('\n').filter(Boolean).map((line, index) => <p key={index} className={/^(个人任务按配置|本轮 AI 复核|退出码未核实)/.test(line) ? 'round-system-note' : ''}>{line}</p>)}</div>}
      {integration?.criteriaResults&&<div className="round-criteria"><h4>整轮标准核对</h4><ul>{integration.criteriaResults.map((result,index)=><li key={index}>{result.verified?'已核实':'未核实'} · {renderInlineMd(result.criterion)}{result.evidence&&<small> · {renderInlineMd(result.evidence)}</small>}</li>)}</ul>{integration.verdict!==integration.outcome&&<small>成员原结论：{integration.verdict}；流程核对结果：{integration.outcome}。原始记录保留。</small>}</div>}
      </details>
      <ReviewDetails projectId={round.projectId} invoke={invoke} artifactId={integration?.version?.artifactId} assessments={integration?.assessments} strengths={integration?.strengths} sources={integration?.checkEvidence} owner={round.deferredUserCriteria??memberCriteria([...(round.completionCriteria??[]),...data.tasks.filter(t=>t.roundId===round.id&&t.status!=='cancelled').flatMap(t=>t.completionCriteria),...(round.index===(data.plan?.rounds.length??0)-1?data.plan?.acceptanceCriteria??[]:[])]).deferred}/>
      {integration?.peerReview&&<details className="round-details"><summary>另一位成员的整轮评价（<MemberName id={integration.peerReview.memberId}/> · {integration.peerReview.outcome==='pass'?'通过':integration.peerReview.outcome==='changes_requested'?'有问题需要修改':'无法下结论'}）</summary>
        {integration.peerReview.criteriaResults?.length?<div className="round-criteria"><h4>交叉复核标准核对</h4><ul>{integration.peerReview.criteriaResults.map((result,index)=><li key={index}>{result.verified?'已核实':'未核实'} · {renderInlineMd(result.criterion)}{result.evidence&&<small> · {renderInlineMd(result.evidence)}</small>}</li>)}</ul></div>:null}
        {integration.peerReview.findings?.length?<div className="round-criteria"><h4>复核发现</h4><ul>{integration.peerReview.findings.map(f=><li key={f.id}>{f.location}：{renderInlineMd(f.request)}</li>)}</ul></div>:null}
        <ReviewDetails projectId={round.projectId} invoke={invoke} artifactId={integration.version?.artifactId} assessments={integration.peerReview.assessments} strengths={integration.peerReview.strengths} sources={integration.peerReview.evidence}/></details>}
      {(round.integrationFixCount>0||Boolean(round.manualRedos?.length)||Boolean(round.userChangeRequests?.length))&&<p className="task-meta">自动整合修正 {round.integrationFixCount}/2 · 人工指定重做 {round.manualRedos?.length??0} 次（每次只做一次） · 用户驳回 {round.userChangeRequests?.length??0} 次（单独记录）</p>}
      {round.manualAcceptance&&<p className="task-meta">本轮由你进行最终判断：{round.manualAcceptance.reason}</p>}
      {checks.flatMap(check=>commandExitCodeNotes(check.evidence??[]).map(note=><p className="task-meta" key={check.id+note}>{note}</p>))}
      {integration&&[...integration.advisoryFindings??[],...integration.findings,...integration.peerReview?.findings??[]].some(finding=>finding.disposition==='advice'||finding.severity==='optional')&&<div className="round-suggestions"><h4>通过后的改进建议</h4><ul>{[...integration.advisoryFindings??[],...integration.findings,...integration.peerReview?.findings??[]].filter(finding=>finding.disposition==='advice'||finding.severity==='optional').map((finding,index)=><li key={finding.id+'-'+index}>{finding.severity==='should-fix'?'应该改':'可选'} · {finding.location}：{renderInlineMd(finding.request)}</li>)}</ul></div>}
      {checks.map(check=><div className="requested-check" key={check.id}><h4><MemberName id={check.memberId}/> · 按你的要求检查：{check.outcome==='pass'?'通过':check.outcome==='changes_requested'?'有问题需要修改':'无法下结论'}</h4><small>检查只提供结果，由你决定通过或驳回。</small><ul>{check.criteriaResults?.map((c,index)=><li key={index}>{c.verified?'已核实':'未核实'} · {renderInlineMd(c.criterion)}：{renderInlineMd(c.evidence)}</li>)}{check.findings?.map(f=><li key={f.id}>{f.location}：{renderInlineMd(f.request)}</li>)}</ul><ReviewDetails projectId={round.projectId} invoke={invoke} artifactId={check.version.artifactId} assessments={check.assessments} strengths={check.strengths} sources={check.evidence}/></div>)}{awaiting&&integration&&<div className="round-actions"><MemberSelect aria-label={`第 ${round.index+1} 轮检查成员`} value={checker} disabled={busy} onChange={e=>setChecker(e.target.value)}>{data.flow?.memberIds.map(id=><option key={id} value={id}>{team.get(id)?.name??id}</option>)}</MemberSelect><button type="button" className="button small secondary" disabled={busy||!allowed(round.allowedActions,'projectFlow.round.requestCheck')} onClick={()=>void onCheck(round,integration,checker)}>请人复核</button></div>}{integration?.version && <div className="round-files"><button type="button" className="link-button" onClick={() => void showDiff()}><FileDiff size={13} />{diff ? '收起改动' : '查看这一轮的改动'}</button>
        {diff && <div className="round-diff"><ul>{diff.changes.map(change => <li key={change.path} className={`change-${change.kind}`}>{change.kind === 'added' ? '新增' : change.kind === 'deleted' ? '删除' : '修改'} {change.path}</li>)}</ul>{diff.text && <pre>{diff.text.slice(0, 40000)}</pre>}</div>}</div>}
      {acceptance?.status === 'applying' && <p className="round-apply"><LoaderCircle size={13} className="spin" />正在把成品写入项目文件夹…</p>}
      {acceptance?.status === 'conflict' && <div className="round-conflicts"><AlertTriangle size={14} />写入前发现项目里这些文件已经被改过，没有写入任何文件：<ul>{acceptance.conflictPaths.map(path => <li key={path}>{path}</li>)}</ul>处理好这些文件后可以重新通过。</div>}
      {acceptance?.status === 'recovery_required' && <div className="round-conflicts bad" role="alert"><AlertTriangle size={14} />验收处理中断，请核对后继续。<div className="round-actions"><button type="button" className="button small secondary" disabled={busy} onClick={() => void onRecover(acceptance.id, acceptance.revision, 'reconcile')}>核对已写入的文件</button><button type="button" className="button small secondary" disabled={busy} onClick={() => void onRecover(acceptance.id, acceptance.revision, 'continue')}>继续写入剩下的</button></div></div>}
      {awaiting && rejecting === null && <div className="round-actions verdict">
        {holding && <small className="round-hold">先在上面处理「{holding.title}」，再通过或驳回。</small>}
        <button type="button" className="button primary" disabled={busy || !allowed(round.allowedActions, 'projectFlow.round.accept')} title={action(round.allowedActions, 'projectFlow.round.accept')?.reason ?? '通过后，这一轮的成品会写回项目文件夹'} onClick={() => void onDecide(round, integration!, 'pass')}><ThumbsUp size={14} />通过</button>
        <button type="button" className="button danger-outline" disabled={busy || !allowed(round.allowedActions, 'projectFlow.round.requestChanges')} title={action(round.allowedActions, 'projectFlow.round.requestChanges')?.reason ?? '负责人会复查并安排修正'} onClick={() => setRejecting('')}><ThumbsDown size={14} />驳回</button>
        <small>通过后写回项目文件夹；驳回交给负责人修正。</small></div>}
      {awaiting && rejecting !== null && <div className="round-reject"><textarea rows={2} autoFocus aria-label="驳回理由（可选）" placeholder="要改什么？可以不写，负责人会自己复查。" value={rejecting} disabled={busy} onChange={event => setRejecting(event.target.value)} />
        <div className="round-actions"><button type="button" className="button small danger-outline" disabled={busy} onClick={() => void onDecide(round, integration!, 'reject', rejecting).then(ok => { if (ok) setRejecting(null); })}><ThumbsDown size={13} />确定驳回</button><button type="button" className="button small quiet" disabled={busy} onClick={() => setRejecting(null)}>取消</button></div></div>}
    </article>
  </MemberLine>;
}

function DecisionCard({ decision, tasks, rounds, busy, leadName, onAskLead, onAnswer }: { decision: Decision; tasks: Task[]; rounds: Round[]; busy: boolean; leadName?: string; onAskLead?: (decision: Decision) => Promise<void>; onAnswer: (params: { choice: string; selectedTaskIds?: string[]; allowAllEligible?: boolean; memberId?: string; opinion?: string; rulings?: DisputeRuling[] }) => Promise<boolean> }) {
  const eligible = decision.eligibleTaskIds.map(id => tasks.find(task => task.id === id)).filter((task): task is Task => Boolean(task));
  const [picked, setPicked] = useState<string[]>(() => eligible.map(task => task.id));
  const team=useTeam(),[memberId,setMemberId]=useState(''),[opinion,setOpinion]=useState(''),[rulings,setRulings]=useState<Record<string,DisputeRuling['verdict']>>({});const requiresMember=(option:string)=>['重新安排','换人复核','换负责人检查','换人接手'].includes(option);
  const recommendation=rounds.find(r=>r.id===decision.roundId)?.nextConfirmation?.recommendation,disputes=decision.disputeItems??[];
  const early = decision.kind === 'early-start';
  return <section className="meeting-card decision-card" aria-label={`决策：${decision.title}`}>
    <div className="decision-card-head"><Hand size={15} /><strong>{decision.title}</strong></div>
    <p className="decision-reason">{plainFlowError(decision.reason)}</p>
    {decision.kind==='next-round'&&<div className="next-round-adjustments"><small>沿用现有负责人和分工。较大的方向或范围变化，请选“要求修改方案”。</small>{recommendation?.taskAdjustments.map(a=><div key={a.taskId}><strong>{tasks.find(t=>t.id===a.taskId)?.title}</strong>{a.goal&&<p>目标：{a.goal}</p>}{a.inputs?.length&&<p>补充输入：{joinClauses(a.inputs,'；')}</p>}{a.completionCriteria&&<ul>{a.completionCriteria.map(c=><li key={criterionText(c)}>核对标准：{criterionText(c)}</li>)}</ul>}</div>)}{recommendation?.completionCriteria&&<ul>{recommendation.completionCriteria.map(c=><li key={criterionText(c)}>整轮标准：{criterionText(c)}</li>)}</ul>}</div>}
    {decision.kind==='review-dispute'&&<div className="review-disputes"><small>每项任务最多返还 {FLOW_LIMITS.disputeReturnWaivers} 次退回次数；超过后仍可裁定，退回正常计数。你可统一裁定，也可逐条选择。</small>{disputes.map(({finding,reason})=><div key={finding.id}><strong>{finding.location} · {finding.request}</strong><p>复核依据：{finding.evidence}</p><p>作者异议：{reason}</p><label>逐条裁定<select aria-label={`裁定「${finding.request}」`} value={rulings[finding.id]??''} disabled={busy} onChange={e=>setRulings({...rulings,[finding.id]:e.target.value as DisputeRuling['verdict']})}><option value="">请选择…</option><option value="uphold-author">支持作者</option><option value="uphold-review">维持复核</option></select></label></div>)}</div>}
    {decision.kind==='replan'&&<small>{decision.stage==='integration-fix'?'仅替换本轮负责人，重做卡住的整合事项；后续轮次仍由原负责人负责。':'仅重做这项任务，保留其他成员已通过的成果。'}人工指定后只重做一次，历史修正次数不清零。</small>}
    {decision.options.some(requiresMember)&&<label>选择接手成员<MemberSelect aria-label={`为「${decision.title}」选择成员`} value={memberId} disabled={busy} onChange={event=>setMemberId(event.target.value)}><option value="">请选择…</option>{(decision.eligibleMemberIds??[]).map(id=><option key={id} value={id}>{team.get(id)?.name??id}</option>)}</MemberSelect></label>}
    {!early&&<textarea aria-label={`「${decision.title}」的补充意见`} rows={2} placeholder="补充意见（可选）" disabled={busy} value={opinion} onChange={event=>setOpinion(event.target.value)}/>}
    {early && eligible.length > 0 && <div className="decision-tasks">{eligible.map(task => <label key={task.id}><input type="checkbox" checked={picked.includes(task.id)} disabled={busy} onChange={event => setPicked(previous => event.target.checked ? [...previous, task.id] : previous.filter(id => id !== task.id))} /><MemberName id={task.memberId} /><span>{task.title}</span></label>)}
      <small>提前开工以已复核的成果为起点；如果这一轮后来又改了它依赖的内容，提前做的部分会标为过期、等待重新安排。</small></div>}
    <div className="round-actions">{decision.options.map(option => {
      const allows = early && option === '允许提前开工';
      return <button key={option} type="button" className={`button small ${allows||option==='按原计划开始'||option==='按调整开始' ? 'primary' : 'secondary'}`} disabled={busy || allows && !picked.length || requiresMember(option)&&!memberId || option==='提交逐条裁定'&&disputes.some(d=>!rulings[d.finding.id]) || !allowed(decision.allowedActions, 'projectFlow.decision.answer')} onClick={() => void onAnswer(allows ? { choice: option, ...(picked.length === eligible.length ? { allowAllEligible: true } : { selectedTaskIds: picked }) } : { choice: option,opinion,...(requiresMember(option)?{memberId}:{}),...(option==='提交逐条裁定'?{rulings:disputes.map(d=>({findingId:d.finding.id,verdict:rulings[d.finding.id],reason:opinion||'用户逐条裁定'}))}:{}) })}>{option}{allows && picked.length !== eligible.length ? `（${picked.length} 项）` : ''}</button>;
    })}{onAskLead && <button type="button" className="button small secondary" disabled={busy} title="在会议室里让负责人用大白话解释当前卡点并给出选择建议" onClick={() => void onAskLead(decision)}>问问 {leadName || '负责人'}</button>}</div>
  </section>;
}

function FlowMemberPicker({ members, busy, actions }: {
  members: TeamMember[];
  busy: boolean;
  actions: { label: string; run: (memberId: string) => Promise<boolean> }[];
}) {
  const [memberId, setMemberId] = useState('');
  const selected = members.some(member => member.id === memberId) ? memberId : '';
  return <div className="round-actions">
    <MemberSelect aria-label={actions.length === 1 ? actions[0].label : '选择修复成员'} value={selected} disabled={busy || !members.length} onChange={event => setMemberId(event.target.value)}>
      <option value="">{members.length ? '选择成员…' : '暂无可用成员'}</option>
      {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
    </MemberSelect>
    {actions.map(({ label, run }) => <button key={label} type="button" className="button small secondary" disabled={busy || !selected} onClick={() => void run(selected).then(ok => { if (ok) setMemberId(''); })}>{label}</button>)}
  </div>;
}

type BoardProps = { invoke:Invoke; rounds: Round[]; tasks: Task[]; data: ProjectFlowSnapshot; snapshot: Snapshot; members: TeamMember[]; busy: boolean; blocked: FlowOperation[]; resultUnknown: (op: FlowOperation) => boolean; onGiveUp: (op: FlowOperation, evidence: string) => Promise<boolean>; onContinue:(op:FlowOperation,evidence:string)=>Promise<boolean>;onLog: (target:LogTarget) => void; onReassign: (task: Task, memberId: string) => Promise<boolean> };
/** The board: one round at a time, its tasks in columns by where they stand; a card opens its details in place. */
function Board(props: BoardProps & { focusedTask?: { task: Task; nonce: number }; onOpenSdd?: () => void }) {
  const { rounds, tasks } = props;
  const current = rounds.find(round => round.status !== 'accepted') ?? rounds.at(-1);
  const [roundId, setRoundId] = useState<string>(), [taskId, setTaskId] = useState<string>();
  const shown = rounds.find(round => round.id === roundId) ?? current, task = tasks.find(item => item.id === taskId);
  useEffect(() => { setRoundId(undefined); }, [current?.id]);
  useEffect(() => {
    if (!props.focusedTask) return;
    setRoundId(props.focusedTask.task.roundId);
    setTaskId(props.focusedTask.task.id);
  }, [props.focusedTask]);
  if (!rounds.length) return <aside className="board board-compact-empty" aria-label="任务清单">
    <p className="board-empty">尚未拆解任务。点上方 <strong>SDD · 双盲规范</strong> 即可起草 Spec、双盲出方案并自动生成任务清单。</p>
  </aside>;
  const inRound = tasks.filter(item => item.roundId === shown?.id);
  const doneInRound = inRound.filter(item => ['review_passed', 'review_skipped', 'integrated', 'accepted'].includes(item.status)).length;
  const pct = inRound.length ? Math.round((doneInRound / inRound.length) * 100) : 0;
  const level=shown&&props.data.flow?(shown.effectiveReviewLevel??roundReviewLevel(props.data.flow,shown)):'high';
  const lanes=LANES.filter(lane=>lane.id!=='review'||level==='high'||inRound.some(item=>item.status==='awaiting_review'));
  const roundWorking = Boolean(shown && props.data.flow && props.data.flow.dispatchMode === 'running' && ['integrating', 'checking'].includes(shown.status));
  const roundLeadMember = roundWorking && shown && props.data.flow ? props.members.find(m => m.id === roundLead(props.data.flow!, shown)) : undefined;
  return <aside className="board" aria-label="任务清单">
    <div className="board-head"><strong>任务进度 {doneInRound}/{inRound.length}</strong>
      <div className="board-rounds" role="tablist" aria-label="轮次">{rounds.map(round => <button key={round.id} type="button" role="tab" aria-selected={round.id === shown?.id} className={`${round.id === shown?.id ? 'selected' : ''} status-${round.status}`} title={`${round.title} · ${ROUND_STATUS[round.status]}`} onClick={() => { setRoundId(round.id); setTaskId(undefined); }}>R{round.index + 1}{round.status === 'accepted' && <Check size={11} />}</button>)}</div></div>
    <div className="board-progress-track" aria-hidden="true"><div className="board-progress-fill" style={{ width: `${pct}%` }} /></div>
    {shown && <div className="board-round-meta"><p className="board-round-goal"><strong>{shown.title}</strong> · {shown.nextConfirmation&&shown.nextConfirmation.status!=='confirmed'?'等待下一轮确认':ROUND_STATUS[shown.status]}</p><button className="link-button" onClick={()=>props.onLog({kind:'round',id:shown.id})}>日志</button></div>}
    {task ? <TaskDetail {...props} task={task} onBack={() => setTaskId(undefined)} />
      : <div className="board-lanes">{lanes.map(lane => {
        const items = inRound.filter(item => lane.statuses.includes(item.status));
        const showRoundCard = lane.id === 'active' && roundWorking && Boolean(shown);
        const count = items.length + (showRoundCard ? 1 : 0);
        if (!count) return null;
        return <section key={lane.id} className={`board-lane lane-${lane.id}`} aria-label={lane.label}><h4>{lane.label}<span>{count}</span></h4>
          {showRoundCard && shown && <button type="button" className={`task-tile status-running${roundLeadMember ? ` member-${roundLeadMember.id}` : ''}`} onClick={() => props.onLog({ kind: 'round', id: shown.id })}>
            <span className="task-tile-top">{roundLeadMember && <Avatar member={roundLeadMember} size={20} ring={false} mood="working" />}<strong>本轮整体检查与整理汇报</strong></span>
            <small><span className="t3-dot t3-dot-working" />{ROUND_STATUS[shown.status]}</small>
          </button>}
          {items.map(item => <TaskTile key={item.id} task={item} data={props.data} onOpen={() => setTaskId(item.id)} />)}</section>;
      })}</div>}
  </aside>;
}

function TaskTile({ task, data, onOpen }: { task: Task; data: ProjectFlowSnapshot; onOpen: () => void }) {
  const member = useTeam().get(task.memberId);
  const review = data.reviews.filter(item => item.taskId === task.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const needsReview=task.reviewRequested===true||task.kind!=='integration-fix'&&(task.effectiveReviewLevel??reviewLevel(data.flow!))==='high';
  const waitingRound=!needsReview&&['review_skipped','integrated'].includes(task.status)&&!['accepted','awaiting_acceptance'].includes(data.rounds.find(round=>round.id===task.roundId)?.status??'');
  const line = task.blockedReason ? plainFlowError(task.blockedReason) : (waitingRound?'等本轮整体检查':['running', 'queued', 'correcting'].includes(task.status) && task.lastActivity ? task.lastActivity.text : review?.status === 'changes_requested' ? '复核要求修改' : TASK_STATUS[task.status]);
  return <button type="button" className={`task-tile member-${task.memberId} status-${task.status}`} aria-label={`任务：${task.title}`} onClick={onOpen}>
    <span className="task-tile-top">{member && <Avatar member={member} size={22} ring={false} mood={task.status === 'running' ? 'working' : undefined} />}<strong>{task.title}</strong></span>
    <small>{['running', 'correcting'].includes(task.status) && <span className="pulse" />}{line}</small>
    <small>{task.reviewSkipped?'未单独复核':!needsReview?'本轮不单独复核':task.review?'单独复核':'复核人'}{needsReview&&!task.reviewSkipped&&<MemberName id={task.reviewerMemberId}/>}</small>
    {task.reusedFromTaskId&&<small>沿用已验证成果</small>}
    {task.returnCount > 0 && <span className="task-tile-returns" title="退回次数，最多 2 次">退回 {task.returnCount}/2</span>}
  </button>;
}

function TaskDetail({ invoke, task, tasks, data, snapshot, members, busy, blocked, resultUnknown, onGiveUp,onContinue, onLog, onReassign, onBack }: BoardProps & { task: Task; onBack: () => void }) {
  const team = useTeam(), member = team.get(task.memberId);
  const taskSession=snapshot.sessions.find(session=>session.id===task.sessionId),location=workspaceLocation(taskSession,snapshot.projects.find(project=>project.id===task.projectId)?.directory);
  const [supplementOpen,setSupplementOpen]=useState(false);
  const review = data.reviews.filter(item => item.taskId === task.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const toRoundtable=useRoundtableNavigation();
  const submission = data.submissions.find(item => item.id === task.latestSubmissionId);
  const evidenceNotes=commandExitCodeNotes([...(submission?.evidence??[]),...(review?.evidence??[])]);
  // What blocks this task: its own attempt or its review, whichever operation is blocked.
  const stuck = blocked.find(op => op.targetId === task.id && op.kind === 'supplement-delivery') ?? blocked.find(op => op.targetId === task.id);
  const waitingOn = task.dependencies.map(id => tasks.find(item => item.id === id)).filter((item): item is Task => Boolean(item) && !['review_passed','review_skipped', 'integrated', 'accepted'].includes(item!.status));
  const canMove = allowed(task.allowedActions, 'projectFlow.task.reassign') && Boolean(action(task.allowedActions, 'projectFlow.task.reassign'));
  return <article className={`task-detail member-${task.memberId}`} aria-label={`任务详情：${task.title}`}>
    <button type="button" className="link-button" onClick={onBack}><ArrowLeft size={13} />回到看板</button>
    {action(task.allowedActions,'projectFlow.task.supplement')?.enabled&&<button className="button small" disabled={busy} onClick={()=>setSupplementOpen(true)}>补充要求</button>}
    {supplementOpen&&<TaskAdditionView data={data} memberId={task.memberId} initialGoal="" supplementTask={task} invoke={invoke} onClose={()=>setSupplementOpen(false)} onDone={()=>setSupplementOpen(false)}/>}
    <div className="task-detail-head">{member && <Avatar member={member} size={34} />}<div><strong>{task.title}</strong><small>{member?.name ?? '成员'} 做 · <MemberName id={task.reviewerMemberId} /> 复核</small></div><span className={`task-chip status-${task.status}`}>{TASK_STATUS[task.status]}</span></div>
    <Markdown text={task.goal} />
    <div className="task-workspace-location"><p title={location.path}>工作位置 · {location.label}</p><small>{location.hint}</small>{taskSession?.workspace&&!taskSession.restoredHistoryOnly&&<button type="button" className="link-button" onClick={()=>void invoke('workspace.open',{sessionId:taskSession.id}).catch(()=>{})}>打开任务工作位置</button>}</div>
    {submission&&toRoundtable&&<button className="link-button" onClick={()=>toRoundtable({projectId:task.projectId,submissionId:submission.id,version:submission.version})}>送去圆桌评审提交</button>}
    {submission&&<><h4>做了什么</h4><Markdown text={memberUserSummary(submission)} />{submission.replyNotes?.map(note=><p className="task-meta" key={note}>{note}</p>)}</>}
    {task.completionCriteria.length > 0 && <><h4>完成标准</h4><ul>{task.completionCriteria.map(item => <li key={criterionText(item)}>{renderInlineMd(criterionText(item))}（{criterionKind(item)==='owner'?'你来定':criterionKind(item)==='judge'?'成员评价':'可核对'}）</li>)}</ul></>}
    {task.allowedPaths.length > 0 && <p className="task-meta">可以修改：{task.allowedPaths.join('、')}</p>}
    {waitingOn.length > 0 && task.status === 'pending' && <p className="task-meta">等 {waitingOn.map(item => item.title).join('、')} 先完成</p>}
    {task.lastActivity && !task.blockedReason && task.status !== 'blocked' && <p className="task-meta">最近：{task.lastActivity.text} · {time(task.lastActivity.at)}</p>}
    {task.blockedReason && <p className="task-meta bad">{plainFlowError(task.blockedReason)}</p>}
    <SupplementReceipts task={task} />
    {submission && <p className="task-meta">第 {submission.sequence} 次提交：改了 {submission.changedFileCount ?? submission.changes.length} 个文件，{submission.evidenceCount ?? submission.evidence.length} 条验证依据{(submission.outOfScopeCount ?? submission.outOfScopeChanges.length) > 0 && <strong className="bad"> · {submission.outOfScopeCount ?? submission.outOfScopeChanges.length} 个文件超出范围</strong>}</p>}
    {review && <p className={`task-meta review-${review.status}`}>复核：{review.status === 'passed' ? '通过' : review.status === 'changes_requested' ? '要求修改' : review.status === 'running' || review.status === 'queued' ? '进行中' : review.status === 'stale' ? '已过期' : review.status === 'inconclusive' ? '无法下结论' : '受阻'} · 退回 {task.returnCount}/2</p>}
    {Boolean(task.disputeReturnWaiverCount)&&<p className="task-meta">异议返还已用 {task.disputeReturnWaiverCount}/{FLOW_LIMITS.disputeReturnWaivers} 次；换人或继续任务会保留此次数。</p>}
    {evidenceNotes.map(note=><p className="task-meta" key={note}>{note}</p>)}
    {task.reviewSkipped&&<p className="task-meta">{task.reviewSkipped==='round-fix'?'整合修正将在整轮检查中核对。':'个人任务按配置省略单独复核。'}</p>}
    {task.reusedFromTaskId&&<p className="task-meta">已核对并沿用旧任务成果，没有重新执行。</p>}{task.reviewerChanges?.map((change,index)=><p className="task-meta" key={index}>复核人 <MemberName id={change.previousMemberId}/> → <MemberName id={change.memberId}/>：{change.reason}</p>)}{task.manualRedos?.length&&<p className="task-meta">人工指定重做 {task.manualRedos.length} 次，每次仅一次工作机会，历史退回次数保留。</p>}
    {review?.criteriaResults&&<><h4>复核标准核对</h4><ul>{review.criteriaResults.map((result,index)=><li key={index}>{result.verified?'已核实':'未核实'} · {renderInlineMd(result.criterion)}{result.evidence&&<small> · {renderInlineMd(result.evidence)}</small>}</li>)}</ul></>}
    <ReviewDetails projectId={task.projectId} invoke={invoke} artifactId={submission?.version?.artifactId} assessments={review?.assessments} strengths={review?.strengths} sources={review?.evidence??submission?.evidence} owner={memberCriteria(task.completionCriteria).deferred}/>
    {review?.deferredUserCriteria?.length&&<p className="task-meta">留待整轮用户验收：{joinClauses(review.deferredUserCriteria,'、')}</p>}
    {review?.findings.length ? <ul className="task-findings">{review.findings.map(finding => <li key={finding.id} className={`finding-${finding.severity}`}><strong>{finding.severity === 'blocking' ? '必须改' : finding.severity === 'should-fix' ? '建议改' : '可选'}</strong> {finding.location}：{renderInlineMd(finding.request)}<small>{finding.kind === 'verified' ? '已核实' : finding.kind === 'suspected' ? '待验证' : '建议'} · {renderInlineMd(finding.evidence)}</small></li>)}</ul> : null}
    <div className="round-actions">
      <button type="button" className="button small secondary" onClick={() => onLog({kind:'task',id:task.id})}>看工作日志</button>
      {snapshot.runs.filter(run=>run.id===task.activeRunId||run.id===review?.runId).map(run=><FlowRunStop key={run.id} run={run} invoke={invoke}/>)}
      {canMove && <MemberSelect aria-label={`把「${task.title}」交给`} disabled={busy} value="" onChange={event => { if (event.target.value) void onReassign(task, event.target.value); }}><option value="">换人…</option>{members.filter(item => item.id !== task.memberId).map(item => <option key={item.id} value={item.id}>交给 {item.name}</option>)}</MemberSelect>}

    </div>
    {stuck && <div className="task-stuck"><p className="task-meta bad">卡在{OPERATION_KIND[stuck.kind] ?? stuck.kind}：{plainFlowError(stuck.error)}</p><GiveUp key={stuck.id} task={stuck.kind === 'task'} unknown={resultUnknown(stuck)} supplement={stuck.kind === 'supplement-delivery'} busy={busy} onContinue={stuck.kind!=='supplement-delivery'?evidence=>onContinue(stuck,evidence):undefined} onConfirm={evidence => onGiveUp(stuck, evidence)} /></div>}
  </article>;
}

/** The whole piece of work at a glance once its last round is accepted: every round, the fixes it took, and what remains. */
function CompletionReport({ report }: { report: FlowCompletionReport }) {
  const fixes = report.corrections.length, returns = report.userReturns.length;
  return <details className="completion-report"><summary>整段工作总结 · {report.rounds.length} 轮{fixes ? ` · ${fixes} 次修正` : ''}{returns ? ` · 你驳回 ${returns} 次` : ''}{report.roundtables.length ? ` · 引用圆桌 ${report.roundtables.length} 次` : ''}</summary>
    <ol>{report.rounds.map(round => <li key={round.roundId}><strong>{round.title}</strong><Markdown text={readableContent(round.summary)} />{round.deliverables.length > 0 && <p className="task-meta">成果：{joinClauses(round.deliverables, '、')}</p>}</li>)}</ol>
    {fixes > 0 && <p className="task-meta">修正：{report.corrections.map(item => item.title).join('；')}</p>}
    {report.remainingIssues.length > 0 && <div className="completion-remaining"><strong>遗留</strong><ul>{report.remainingIssues.map(item => <li key={item}>{renderInlineMd(item)}</li>)}</ul></div>}
  </details>;
}
const SUPPLEMENT_STATUS: Record<TaskSupplement['status'], string> = { pending: '等待送达', delivering: '正在送达', delivered: '已送达，成员正在处理', submitted: '已随提交交回', applied: '已纳入', unknown: '是否送达待核对', awaiting_scope: '超出范围，等你决定', dismissed: '已撤回', replanned: '已转入新方案' };
/** Each extra requirement shows where it stands: sent, taken into the work, or waiting on the owner. */
export function SupplementReceipts({ task }: { task: Task }) {
  if (!task.supplements?.length) return null;
  return <div className="supplement-receipts" aria-label={`「${task.title}」的补充要求`}><strong>补充要求 · {task.title}</strong><ul>{task.supplements.map(item => <li key={item.id}><span>{item.text}</span><small className={`supplement-${item.status}`}>{SUPPLEMENT_STATUS[item.status] ?? item.status} · {time(item.createdAt)}</small></li>)}</ul></div>;
}
/** Giving up a blocked attempt, with its reason asked inline (the desktop window has no prompt()). */
export function GiveUp({ unknown, supplement = false, task = false, busy, onConfirm,onContinue }: { unknown: boolean; supplement?: boolean; task?: boolean; busy: boolean; onConfirm: (evidence: string) => Promise<boolean>;onContinue?:(evidence:string)=>Promise<boolean> }) {
  const [reason, setReason] = useState<string | null>(null),[continuing,setContinuing]=useState(false);
  if (reason === null) return <div className="round-actions">{onContinue&&<button type="button" className="button small secondary" disabled={busy} onClick={()=>{setContinuing(true);setReason('');}}>接着做</button>}<button type="button" className="button small danger-outline" disabled={busy} onClick={() => {setContinuing(false);setReason('');}}>{unknown ? '放弃旧尝试' : '放弃这次尝试，重新安排'}</button></div>;
  return <div className="task-giveup" role="group" aria-label="放弃这次尝试">
    <p>{continuing?'先查看原工作记录，确认旧运行已经结束，可选填核对情况。接着做会沿用原会话，作者保留原副本；复核会重新核对同一成果版本。':supplement ? '本次补充是否送达尚未核对。查看工作记录后，可以直接放弃旧尝试；补充要求会保留，点“继续”后重新执行。' : unknown ? '这一次的结果未知。看过工作记录后，可以直接放弃这次旧尝试；核对情况可选填。' : task ? '放弃后由同一位成员开新会话，从本轮起点重新做这项任务；上次副本里的改动不保留，原因会记录下来。要换人，请在任务卡上选“换人…”。流程运行中会立即重新开始；暂停时需点“继续”。' : '放弃这次没通过检查的尝试，原因会记录下来，再按同一成果版本重新安排。流程运行中会继续安排；暂停时需点“继续”。'}</p>
    <textarea rows={2} aria-label="补充要求或放弃原因" placeholder="补充要求、修正提示或放弃原因（可选，重新起草方案时会自动带给负责人）" value={reason} onChange={event => setReason(event.target.value)} />
    <div className="round-actions"><button type="button" className="button small primary" disabled={busy} onClick={() => void (continuing?onContinue!:onConfirm)(reason.trim()).then(ok => { if (ok) setReason(null); })}>{continuing?'确定接着做':'确定放弃'}</button><button type="button" className="button small quiet" disabled={busy} onClick={() => setReason(null)}>取消</button></div>
  </div>;
}
