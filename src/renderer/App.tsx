import { sharedUsageFor } from '../shared/desktop-hud';
import { useHudSnapshot } from './use-hud-snapshot';
import {applySnapshotPatch,acceptSnapshot} from '../shared/snapshot-sync';
import { ProjectRoom } from './project-room';
import {MemberReports} from './member-reports';
import type {ReportEntry} from './report-switcher';
import {MemberDesk} from './member-desk';
import type {MemberReportPage} from '../shared/project-workbench';
import './project-workbench.css';
import { isConversationSession } from '../shared/session-classification';
import { idleActivity } from './life-status';
import { unwrapProjectFlowReply } from '../shared/project-flow';
import { AttentionEntry } from './attention';
import type { AttentionItem } from '../shared/attention';
import type { RoomFocus } from './room';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CalendarClock, AlertCircle, CheckCircle2, ChevronDown, ChevronRight,
  Folder, FolderOpen, Globe2, Plus, RefreshCw, Settings2, StopCircle, Users, X,
  MoreHorizontal, Trash2, GitMerge, Pencil, MessagesSquare, IdCard, Laptop, Search,
  GitBranch, GitCompareArrows, Terminal, History, Sun, Moon, PanelRightClose, Sparkles, Wrench,
} from 'lucide-react';
import { BUILTIN_MEMBERS, DEFAULT_PROFILE, DEFAULT_SETTINGS, rememberExecutors } from '../shared/defaults';
import type { Project, ProviderId, Session, Settings, Snapshot } from '../shared/types';
import { ErrorBoundary } from './ErrorBoundary';
import { Avatar, MOOD_TEXT, Portrait, TeamColors, TeamProvider, UserAvatar, makeTeam, memberIdOf, moodOf, type Mood, type Team, type TeamMember } from './members';
import { InviteModal, Modal, ProjectModal } from './modals';
import {ProjectHierarchyModal} from './project-tree';
import {projectRows,descendantIds} from '../shared/project-tree';
import { needsMembers, saveProjectMembers } from './project-members';
import { RoomView } from './room';
import { RoomBackdrop } from './room-backdrop';
import { LaunchSplash } from './launch-splash';
import { TarotStage } from './tarot-stage';
import {RoundtableView,type RoundtableRequest} from './roundtable';
import {RoundtableNavigation} from './roundtable-navigation';
import { SetupChecklist } from './setup';
import { MemberCard, type MemberCardTarget, type MemberStatus } from './member-card';

/** The team room beside the open session: remembered per computer, offered from this window width. */
import { SettingsModal, type Installs, type SettingsTab, type ThemeChoice } from './settings';
import qqOfficialIcon from './assets/qq-official.png';
import { QuotaBadge, QuotaOverview } from './quota';
import { AutomationPanel } from './automation';
import { ContextMenu, QuickSwitcher, isBusy, useMemberNotifications, type CommandPaletteAction, type MenuItem, type MenuState } from './interactions';
import {refreshAfterRpc} from '../shared/rpc-refresh';
import {
  IconButton, errorText, greeting, isActiveRun, providerSummary, runnable,
  sessionTitle, useTicker, type Invoke,
} from './ui';
import { useSegmentedIndicator } from './segmented-indicator';

const EMPTY_SNAPSHOT: Snapshot = {
  projects: [], sessions: [], runs: [], events: [], approvals: [], providers: [],
  settings: DEFAULT_SETTINGS, collaborations: [], dataDirectory: '', backendReady: false,
  deepseekKeyConfigured: false, members: [], profile: DEFAULT_PROFILE,
  room: { messages: [], state: { active: false, mode: 'chat' }, currentThreadId: 'room-main', threads: [{ id: 'room-main', title: '当前话题', createdAt: '' }], hasMore: false },
};

/** A backend from before cards and the room sends none of those fields; fill them so the room still renders. */
const withDefaults = (snapshot: Snapshot): Snapshot => {
  // Connected programs are named like built-in executors everywhere, so register their names first.
  rememberExecutors(snapshot.executors ?? []);
  return withSnapshotDefaults(snapshot);
};
// A missing roster is a legacy backend; an explicit [] is a real empty team and must stay empty.
const withSnapshotDefaults = (snapshot: Snapshot): Snapshot => ({ ...snapshot, executors: snapshot.executors ?? [], members: snapshot.members ?? BUILTIN_MEMBERS, profile: snapshot.profile ?? DEFAULT_PROFILE, room: { ...EMPTY_SNAPSHOT.room, ...snapshot.room, threads: snapshot.room?.threads ?? EMPTY_SNAPSHOT.room.threads } });

/** Combine event lists without duplicates, keeping the first list's order and appending newer ones. */

type ModalName = 'project' | 'session' | 'settings' | 'collaboration' | 'invite' | null;
type Toast = { id: number; text: string; error?: boolean };

const THEME_KEY = 'fountain.theme';
function readTheme(): ThemeChoice {
  try { const value = localStorage.getItem(THEME_KEY); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; }
}

/** Mostly-Latin reasoning is the member's original language; say so instead of leaving it unexplained. */




export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [memberStop,setMemberStop]=useState<{memberId:string;token:string;runs:{runId:string;title:string;location:string;projectName?:string}[]}>(),[memberStopping,setMemberStopping]=useState(false),[memberStopError,setMemberStopError]=useState('');
  // Snapshots carry only live events; the open session's full record is fetched and kept current here.
  const [loaded, setLoaded] = useState(false);
  const [backendMessage, setBackendMessage] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [modal, setModal] = useState<ModalName>(null);
  const draggingProject=useRef<Project|null>(null);
  const [projectDrop,setProjectDrop]=useState<{id:string;position:'before'|'after'}>();
  const [hierarchy,setHierarchy]=useState<{mode:'child'|'move';target:Project}>();
  const [collapsedProjects,setCollapsedProjects]=useState<Set<string>>(()=>{try{const ids=JSON.parse(localStorage.getItem('fountain.project-tree.collapsed')??'[]');return new Set(Array.isArray(ids)?ids.filter(id=>typeof id==='string').slice(0,5000):[]);}catch{return new Set();}});
  useEffect(()=>{try{localStorage.setItem('fountain.project-tree.collapsed',JSON.stringify([...collapsedProjects]));}catch{}},[collapsedProjects]);
  useEffect(()=>{const byId=new Map(snapshot.projects.map(p=>[p.id,p])),ancestors=new Set<string>();let p=byId.get(projectId);while(p?.parentId&&!ancestors.has(p.parentId)){ancestors.add(p.parentId);p=byId.get(p.parentId);}setCollapsedProjects(old=>{if(![...ancestors].some(id=>old.has(id)))return old;return new Set([...old].filter(id=>!ancestors.has(id)));});},[projectId,snapshot.projects.map(p=>p.id+':'+p.parentId).join('|')]);
  const [quotaOpen,setQuotaOpen]=useState(false);
  const [automationOpen,setAutomationOpen]=useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('members');
  const [settingsEditing, setSettingsEditing] = useState<string | null>(null);
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  const [view, setView] = useState<'work' | 'room' | 'project' | 'desk' | 'reports' | 'roundtable'>('work');
  const [deskMemberId,setDeskMemberId]=useState('codex'),[reportMemberId,setReportMemberId]=useState('codex'),[reportRosterState,setReportRoster]=useState<{projectId:string;members:MemberReportPage['members']}>({projectId:'',members:[]});
  const reportRoster=reportRosterState.projectId===projectId?reportRosterState.members:[];
  const reportEntries:ReportEntry[]=reportRoster.map(m=>({...m,unread:snapshot.rooms?.some(r=>r.roomId===`report:${projectId}:${m.id}`&&r.unread)}));
  const openReport=(memberId:string)=>{setReportMemberId(memberId);setView('reports');setSessionId('');};
  const [hudSessionId, setHudSessionId] = useState<string>();
  const [roomFocus, setRoomFocus] = useState<RoomFocus>();
  const [roundtableRequest,setRoundtableRequest]=useState<RoundtableRequest>();
  const [inviteProject, setInviteProject] = useState<string>();
  const [toast, setToast] = useState<Toast | null>(null);
  const [probing, setProbing] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [installs, setInstalls] = useState<Installs>({});
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [menu, setMenu] = useState<MenuState>(null);
  const [renaming, setRenaming] = useState<{ kind: 'session' | 'project'; id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'delete-session' | 'remove-project' | 'discard'; id: string; discard: boolean } | null>(null);
  const [switcher, setSwitcher] = useState(false);
  useSegmentedIndicator();
  const toastCounter = useRef(0);

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  const notify = useCallback((text: string, error = false) => {
    setToast({ id: ++toastCounter.current, text, error });
  }, []);
  const refresh = useCallback(async () => {
    if (!window.fountain) throw new Error('请在 FountAIn 桌面应用中打开工作台。');
    const next = withDefaults(await window.fountain.invoke<Snapshot>('snapshot'));
    setSnapshot(previous=>acceptSnapshot(previous,next));
    setLoaded(true);
    return next;
  }, []);
  const invoke: Invoke = useCallback(async <T,>(method: string, params?: unknown, success?: string, options?:{background?:boolean}): Promise<T> => {
    try {
      if (!window.fountain) throw new Error('桌面后端尚未连接。');
      const result = unwrapProjectFlowReply(await window.fountain.invoke<T>(method, params));
      if(method==='settings.save')setSnapshot(previous=>({...previous,settings:result as Settings}));
      else if(refreshAfterRpc(method))await refresh();
      if (success) notify(success);
      return result;
    } catch (error) {
      if(!options?.background)notify(errorText(error), true);
      throw error;
    }
  }, [notify, refresh]);
  const perform = useCallback((method: string, params?: unknown, success?: string) => {
    void invoke(method, params, success).catch(() => {});
  }, [invoke]);
  function openCollaboration() {openInvite(project?.id);}
  function openInvite(projectId?: string) { setInviteProject(projectId); setModal('invite'); }
  /** A project without chosen members starts at 请大家一起来; one with people opens its meeting room. */
  // The window waits a moment so a double-click (rename) on the same row can cancel it.
  const inviteTimer = useRef<number | undefined>(undefined);
  function openProject(target: Project) { window.clearTimeout(inviteTimer.current); if (needsMembers(snapshot, target)) { inviteTimer.current = window.setTimeout(() => openInvite(target.id), 260); return; } setView('project'); setProjectId(target.id); setSessionId(''); }
  async function enterMeeting(targetId: string, memberIds: string[]) { await saveProjectMembers(invoke, targetId, memberIds); setModal(null); setView('project'); setProjectId(targetId); setSessionId(''); }
  function openSettings(tab: SettingsTab = 'members', editing: string | null = null, focus: string | null = null) { setSettingsTab(tab); setSettingsEditing(editing); setSettingsFocus(focus); setModal('settings'); }
  /** A pending item opens where it can be handled; opening never answers, resends, accepts or applies anything. */
  function openAttention(item: AttentionItem) {
    if(item.jointReviewId){const topic=snapshot.roundtable?.topics.find(t=>t.reviewId===item.jointReviewId);if(topic){setRoundtableRequest({topicId:topic.id,nonce:Date.now()});setView('roundtable');setSessionId('');return;}if(item.projectId){setProjectId(item.projectId);setView('project');setSessionId('');return;}}
    if(item.action.view==='member-settings'){openSettings('members',null,item.provider??item.memberId??null);return;}
    if(item.action.view==='room'){setView('room');setSessionId('');setRoomFocus({threadId:item.threadId,messageId:item.messageId,nonce:Date.now()});return;}
    if(item.action.view==='project-room'&&item.kind==='acceptance'&&item.roomId?.startsWith('project:')){setProjectId(item.roomId.slice(8));setView('project');setSessionId('');return;}
    const target=item.sessionId&&snapshot.sessions.find(s=>s.id===item.sessionId);
    if(target){openRecordedSession(target);return;}
    // The item's session no longer exists: open its project instead.
    if (item.action.view === 'project-room') { setView('project'); if (item.projectId) setProjectId(item.projectId); setSessionId(''); }
    else { setView('work'); if (item.projectId) setProjectId(item.projectId); setSessionId(''); }
  }
  function openSession(memberId?: string) { const id=memberId??deskMemberId;openDesk(id);perform('desk.topic',{memberId:id},'已开始新的工位话题。'); }

  useEffect(() => {
    if (!window.fountain) {
      setLoaded(true);
      setBackendMessage('桌面后端未连接。请从 FountAIn 桌面应用打开工作台。');
      return;
    }
    const unsubscribe = window.fountain.onEvent(event => {
      if (event.type === 'snapshot') {
        setSnapshot(previous=>acceptSnapshot(previous,withDefaults(event.snapshot)));
        setLoaded(true);
      } else if(event.type==='snapshot-patch'){
        setSnapshot(previous=>{const next=applySnapshotPatch(previous,event);if(!next){queueMicrotask(()=>void refresh().catch(()=>{}));return previous;}return withDefaults(next);});
      } else if (event.type === 'event') {
        setSnapshot(previous => previous.events.some(item => item.id === event.event.id) ? previous : {
          ...previous, events: [...previous.events, event.event],
        });
      } else if(event.type==='hud-focus') {
        setHudSessionId(event.sessionId);
      } else if(event.type==='backend') {
        setSnapshot(previous => ({ ...previous, backendReady: event.ready }));
        setBackendMessage(event.message ?? '');
      }
    });
    void refresh().catch(error => { setLoaded(true); setBackendMessage(errorText(error)); });
    return unsubscribe;
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.error ? 9000 : 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const hudUsage = useHudSnapshot(snapshot.backendReady);
  const team: Team = useMemo(() => makeTeam(snapshot.members,snapshot.removedMembers,snapshot.executors), [snapshot.members,snapshot.removedMembers,snapshot.executors]);
  // The chat room lives in a hidden project; project lists and pickers only show real work.
  const loungeId = snapshot.projects.find(project => project.kind === 'lounge')?.id;
  const workProjects = useMemo(() => snapshot.projects.filter(project => !project.kind), [snapshot.projects]);
  useEffect(() => {
    if (projectId && !workProjects.some(project => project.id === projectId)) setProjectId('');
  }, [workProjects, projectId]);
  useEffect(() => {
    const choices = snapshot.sessions.filter(session => session.projectId === projectId);
    if (sessionId && !choices.some(session => session.id === sessionId)) setSessionId('');
  }, [snapshot.sessions, projectId, sessionId]);

  const project = snapshot.projects.find(item => item.id === projectId);
  const reportsStamp=JSON.stringify([snapshot.projectFlows?.filter(f=>f.projectId===projectId),snapshot.runs.filter(r=>r.projectId===projectId).map(r=>[r.id,r.status,r.updatedAt]),project?.memberIds]);
  useEffect(()=>{let current=true;if(snapshot.backendReady&&projectId)void invoke<MemberReportPage>('projectFlow.memberReports',{projectId,limit:1}).then(p=>{if(current&&p?.members)setReportRoster({projectId,members:p.members});}).catch(()=>{});return()=>{current=false;};},[projectId,reportsStamp,snapshot.backendReady,invoke]);
  useEffect(() => {
    if (!hudSessionId) return;
    const target = snapshot.sessions.find(item => item.id === hudSessionId);
    if (target) openRecordedSession(target);
    setHudSessionId(undefined);
  }, [hudSessionId, snapshot.sessions]);
  function openDesk(memberId:string){setDeskMemberId(memberId);setView('desk');setSessionId('');perform('desk.open',{memberId});}
  function openRecordedSession(target:Session){
    const personal=snapshot.rooms?.find(r=>r.roomId===target.roomId);
    if(target.roomId?.startsWith('report:')){if(personal?.projectId)setProjectId(personal.projectId);setReportMemberId(personal?.memberId??memberIdOf(target));setView('reports');setSessionId('');return;}
    if(target.roomId?.startsWith('project:')){setProjectId(target.roomId.slice(8));setView('project');setSessionId('');return;}
    if(target.roomId==='global'||target.roomThreadId&&!target.flowId){setView('room');setSessionId('');return;}
    if(!isConversationSession(target,snapshot.runs)){setProjectId(target.projectId);setReportMemberId(memberIdOf(target));setView('reports');setSessionId('');return;}
    const id=memberIdOf(target);openDesk(id);const folder=snapshot.projects.find(p=>p.id===target.projectId)?.directory;
    if(folder)void invoke('desk.switchFolder',{memberId:id,directory:folder}).then(()=>invoke('room.select',{roomId:`desk:${id}`,threadId:`desk-topic-${target.id}`})).catch(()=>{});
  }
  const firstInput = useCallback((id: string) => snapshot.runs.filter(run => run.sessionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.inputPreview, [snapshot.runs]);
  const openFromNotice = useCallback((target: Session) => {
    openRecordedSession(target);
  }, [snapshot.sessions,snapshot.rooms,snapshot.runs]);
  useMemberNotifications(snapshot, firstInput, openFromNotice, team);
  const pendingApprovals = snapshot.approvals.filter(approval => approval.state === 'pending');
  const allRunning = snapshot.runs.filter(run => isActiveRun(run) || run.status === 'queued');
  // Each member's mood comes from the runs of their own sessions (custom members included).
  const memberOfSession = useMemo(() => new Map(snapshot.sessions.map(item => [item.id, memberIdOf(item)])), [snapshot.sessions]);
  const moods = useMemo(() => Object.fromEntries(team.members.map(member => {
    const info = snapshot.providers.find(item => item.id === member.executor);
    const memberRuns = snapshot.runs.filter(run => memberOfSession.get(run.sessionId) === member.id);
    const waiting = pendingApprovals.some(approval => memberOfSession.get(approval.sessionId) === member.id) || memberRuns.some(run => run.status === 'waiting_user' && !run.completedAt);
    return [member.id, moodOf(info, memberRuns, waiting, runnable(info))];
  })) as Record<string, Mood>, [team, snapshot.providers, snapshot.runs, pendingApprovals, memberOfSession]);

  async function probe() {
    setProbing(true);
    try { await invoke('provider.probe'); } catch {} finally { setProbing(false); }
  }
  async function restartBackend() {
    if (!window.fountain || restarting) return;
    setRestarting(true);
    try {
      const result = await window.fountain.invoke<{ detail?: string; message?: string }>('backend.restart');
      notify(result?.detail ?? result?.message ?? '已请求重启工作台后端。');
      await refresh();
    } catch (error) { notify(errorText(error), true); }
    finally { setRestarting(false); }
  }
  async function reorderProject(source:Project,target:Project,position:'before'|'after') {
    if(source.id===target.id||source.parentId!==target.parentId)return;
    try{
      await invoke('project.reorder',{projectId:source.id,targetId:target.id,position,
        expectedRevision:source.hierarchyRevision??0,targetRevision:target.hierarchyRevision??0,requestId:crypto.randomUUID()});
      await refresh();
    }catch{/* invoke reports the error and the tree keeps its current order. */}
  }
  async function createdProject(params: { name: string; directory: string }) {
    const result = await invoke<Project>('project.create', params);
    const next = await refresh();
    const id = result?.id ?? next.projects.find(item => item.directory === params.directory)?.id ?? '';
    setProjectId(id);
    if (id) openInvite(id); else setModal(null);
    notify('项目已加入工作室，请选择参加的成员。');
  }
  async function createdInviteProject(params: { name: string; directory: string }) {
    const result = await invoke<Project>('project.create', params);
    const next = await refresh();
    notify('项目已加入工作室。');
    return result ?? next.projects.find(item => item.directory === params.directory);
  }
  async function commitRename() {
    if (!renaming) return;
    const value = renaming.value.trim(); const target = renaming; setRenaming(null);
    if (!value) return;
    if (target.kind === 'session') await invoke('session.update', { sessionId: target.id, title: value }).catch(() => {});
    else await invoke('project.update', { projectId: target.id, name: value }).catch(() => {});
  }
  async function runConfirm() {
    if (!confirm) return;
    const target = confirm; setConfirm(null);
    try {
      if (target.kind === 'delete-session') { await invoke('session.delete', { sessionId: target.id, discardWorkspace: target.discard }, '会话已删除。'); if (target.id === sessionId) setSessionId(''); }
      else if (target.kind === 'remove-project') { await invoke('project.remove', { projectId: target.id, discardWorkspaces: target.discard }, '项目已从工作室移除，文件夹没有改动。'); if (target.id === projectId) { setProjectId(''); setSessionId(''); } }
      else await invoke('workspace.discard', { sessionId: target.id }, '工作副本已丢弃，下一轮会从项目重新建立。');
    } catch {}
  }
  function projectMenuItems(target: Project): MenuItem[] {
    const busy = snapshot.sessions.some(item => item.projectId === target.id && isBusy(snapshot, item.id)),hasChildren=descendantIds(snapshot.projects,target.id).length>1;
    return [
      {label:'添加子项目…',icon:<Plus size={14}/>,onSelect:()=>setHierarchy({mode:'child',target})},
      {label:'归属与修改范围…',icon:<GitMerge size={14}/>,onSelect:()=>setHierarchy({mode:'move',target})},
      { label: '重命名', icon: <Pencil size={14} />, onSelect: () => setRenaming({ kind: 'project', id: target.id, value: target.name }) },
      'separator',
      { label: hasChildren?'移除（先移出子项目）':busy ? '移除（先停止任务）' : '从工作室移除…', icon: <Trash2 size={14} />, danger: true, disabled: busy||hasChildren, onSelect: () => setConfirm({ kind: 'remove-project', id: target.id, discard: true }) },
    ];
  }
  const openMenu = (event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, items }); };

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') { event.preventDefault(); setSwitcher(value => !value); }
      else if (key === 'n' && !modal && snapshot.backendReady) { event.preventDefault(); openSession(); }
      else if (key === ',' && !modal) { event.preventDefault(); openSettings('connections'); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  });
  function onInstall(provider: ProviderId, version: string | null) {
    setInstalls(previous => { const next = { ...previous }; if (version) next[provider] = { version, startedAt: Date.now() }; else delete next[provider]; return next; });
  }

  /** What a member is doing now, for the roster and the member card. */
  // Idle members go about their day: the sidebar line follows the time of day, refreshed each minute.
  const clock = useTicker(true, 60_000);
  function memberStatus(id: string): MemberStatus {
    const member = team.get(id), info = member && snapshot.providers.find(item => item.id === member.executor), mood = moods[id];
    const install = member && installs[member.executor];
    const workingRun = snapshot.runs.find(run => memberOfSession.get(run.sessionId) === id && (isActiveRun(run) || run.status === 'queued'));
    const working = workingRun && snapshot.sessions.find(item => item.id === workingRun.sessionId), inRoom = working?.projectId === loungeId;
    const text = install ? `正在安装 ${install.version}…` : mood === 'working' && working ? inRoom ? '正在聊天室说话' : `正在做：${sessionTitle(working, firstInput(working.id))}` : mood === 'offline' || mood === 'away' ? providerSummary(info) : mood === 'resting' && member ? `空闲 · ${idleActivity(member.card, new Date(clock)).text}` : MOOD_TEXT[mood];
    return { mood, text, session: mood === 'working' ? working : undefined, inRoom };
  }
  async function prepareMemberStop(memberId:string){setMemberStopError('');try{setMemberStop(await invoke('member.stop.preview',{memberId}));}catch(e){notify(errorText(e));}}
  async function confirmMemberStop(){if(!memberStop)return;setMemberStopping(true);setMemberStopError('');try{const r=await invoke<{remaining:unknown[]}>('member.stop',{memberId:memberStop.memberId,token:memberStop.token,confirm:true});if(r.remaining.length)setMemberStopError('停止要求已发送，仍有运行正在核对退出。请等待并查看实际记录。');else setMemberStop(undefined);}catch(e){setMemberStopError(errorText(e));try{setMemberStop(await invoke('member.stop.preview',{memberId:memberStop.memberId}));}catch{}}finally{setMemberStopping(false);}}
  const [memberCard, setMemberCard] = useState<MemberCardTarget | null>(null);
  const closeMemberCard = useCallback(() => setMemberCard(null), []);
  const openMemberCard = (memberId: string, anchor: Element) => setMemberCard(current => current?.memberId === memberId ? null : { memberId, rect: anchor.getBoundingClientRect() });

  return <TeamProvider value={team}><RoundtableNavigation.Provider value={source=>{const {projectId,...ref}=source;setRoundtableRequest({projectId,source:ref,nonce:Date.now()});setView('roundtable');setSessionId('');}}><TeamColors team={team} /><div className="app-root"><WindowTitleBar invoke={invoke} /><div className={`app-shell side-hidden`}>
    <aside className="sidebar">
      <div className="sidebar-brand-row">
      <button type="button" className="brand compact-brand" onClick={() => { setView('work'); setSessionId(''); }} title="FountAIn · 回到主页">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="fn-core" cx="35%" cy="30%" r="70%"><stop offset="0%" stopColor="#ffb380" /><stop offset="55%" stopColor="#e87338" /><stop offset="100%" stopColor="#b54414" /></radialGradient>
              <radialGradient id="fn-top" cx="35%" cy="30%" r="70%"><stop offset="0%" stopColor="#8ab4ff" /><stop offset="55%" stopColor="#3c66d9" /><stop offset="100%" stopColor="#203c94" /></radialGradient>
              <radialGradient id="fn-left" cx="35%" cy="30%" r="70%"><stop offset="0%" stopColor="#b4abff" /><stop offset="55%" stopColor="#7b6fd6" /><stop offset="100%" stopColor="#4c419c" /></radialGradient>
              <radialGradient id="fn-right" cx="35%" cy="30%" r="70%"><stop offset="0%" stopColor="#dda8ff" /><stop offset="55%" stopColor="#a35bdb" /><stop offset="100%" stopColor="#6b2e9e" /></radialGradient>
            </defs>
            <circle cx="20" cy="8.5" r="5.4" fill="url(#fn-top)" />
            <circle cx="8.8" cy="29.5" r="5.4" fill="url(#fn-left)" />
            <circle cx="31.2" cy="29.5" r="5.4" fill="url(#fn-right)" />
            <circle cx="20" cy="21.5" r="5.6" fill="url(#fn-core)" />
          </svg>
        </span>
        <span className="compact-brand-name">Fount<span className="welcome-brand-ai">AI</span>n</span>
      </button>
      <button type="button" className="icon-button sidebar-quick-search" title="快速搜索与跳转 (Ctrl+K)" aria-label="快速搜索" onClick={() => setSwitcher(true)}><Search size={15} /></button>
      </div>

      <div className="sidebar-scroll">
      <div className="sidebar-section-label"><span>团队</span><span className="team-header-actions"><IconButton label="桌面浮层" onClick={()=>void invoke('hud.open')}><Laptop size={14}/></IconButton><IconButton label="自动功能与定时任务" onClick={()=>setAutomationOpen(true)}><CalendarClock size={14}/></IconButton><IconButton label="用量与额度" onClick={()=>setQuotaOpen(true)}><Activity size={14}/></IconButton><IconButton label="检查所有成员" onClick={() => void probe()} disabled={probing || !snapshot.backendReady}><RefreshCw size={14} className={probing ? 'spin' : ''} /></IconButton></span></div>
      <ErrorBoundary area="团队列表" compact><div className="team-roster">
        {team.members.filter(member=>!member.card.cardHidden).map(member => {
          const id = member.id;
          const status = memberStatus(id);
          const running = allRunning.some(run=>memberOfSession.get(run.sessionId)===id);
          const deskNews = snapshot.rooms?.some(r=>r.roomId===`desk:${id}`&&(r.unread||r.pending));
          const deskOpen = view==='desk' && deskMemberId===id;
          return <div className={`roster-with-desk member-${id} ${deskOpen?'selected':''}`} key={id}><button type="button" className={`roster-row member-${id} mood-${status.mood} ${memberCard?.memberId === id ? 'open' : ''}`} key={id} aria-haspopup="dialog" onClick={event => openMemberCard(id, event.currentTarget)}>
            <Avatar member={member} size={32} mood={status.mood} />
            <span className="roster-text"><span className="roster-name"><strong>{member.name}</strong><QuotaBadge provider={member.executor} quota={snapshot.quotas?.[member.executor]} shared={sharedUsageFor(hudUsage, member.id, snapshot.settings.claudeAuthMode === 'api')}/></span><small title={status.text}>{status.text}</small></span>
          </button><span className="roster-actions">{running&&<button type="button" className="icon-button roster-member-stop" aria-label={'中止 '+member.name} title={'中止 '+member.name+' 当前所有运行'} disabled={memberStopping||!snapshot.backendReady} onClick={()=>void prepareMemberStop(id)}><StopCircle size={14}/></button>}<button type="button" className={`icon-button roster-desk ${deskNews?'has-news':''}`} aria-label={member.name+' 的工位'} aria-current={deskOpen?'page':undefined} title={member.name+' 的工位：单独聊天'} onClick={()=>openDesk(id)}><Laptop size={15}/>{deskNews&&<span className="unread-dot" aria-label="工位有新结果或待回应"/>}</button></span></div>;
        })}
        {(() => {
          const qq = snapshot.qqBridge;
          const qqCfg = snapshot.settings.qqBridge;
          const connected = Boolean(qq?.connected);
          const hasError = Boolean(qq?.error);
          const listening = Boolean(qq?.listening && !connected);
          const dotClass = hasError ? 'error' : connected ? 'connected' : listening ? 'listening' : 'offline';
          const badgeText = hasError ? '异常' : connected ? '在线' : listening ? '待连' : '未开';
          const subText = hasError
            ? '端口异常 · 点击查看'
            : connected
              ? `已连接 · ${qq?.activeRoomName || '茶歇室'}`
              : listening
                ? `监听 ${qq?.port ?? 8643} · 等待 NapCat`
                : '未开启 · 点击配置';
          const openQqTargetRoom = () => {
            const rid = qq?.activeRoomId;
            if (rid && rid.startsWith('project:')) {
              setProjectId(rid.slice(8));
              setView('project');
              setSessionId('');
            } else {
              setView('room');
            }
          };
          return <div className="roster-with-desk member-qq-bridge">
            <button type="button" className="roster-row member-qq-bridge" onClick={() => openSettings('connections', null, 'qq-bridge')} title={connected && qq?.botQq ? `QQ Bridge 已连接（${qq.botQq}）· 点击打开设置` : '点击打开 QQ Bridge 设置'}>
              <span className={`qq-bridge-avatar ${dotClass}`}>
                {connected && qq?.botAvatarDataUrl ? (
                  <img src={qq.botAvatarDataUrl} alt="QQ 头像" />
                ) : (
                  <img src={qqOfficialIcon} alt="QQ" className="qq-official-fallback" />
                )}
                <span className={`qq-bridge-dot ${dotClass}`} />
              </span>
              <span className="roster-text">
                <span className="roster-name"><strong>QQ Bridge</strong><span className={`qq-bridge-tag ${dotClass}`}>{badgeText}</span></span>
                <small title={subText}>{subText}</small>
              </span>
            </button>
            <span className="roster-actions">
              {connected ? (
                <button type="button" className="icon-button roster-desk" title={`打开当前遥控房间：${qq?.activeRoomName || '茶歇室'}`} aria-label="打开 QQ 遥控房间" onClick={openQqTargetRoom}><MessagesSquare size={15} /></button>
              ) : qqCfg?.enabled && qqCfg?.napcatLauncher ? (
                <button type="button" className="icon-button roster-desk" title="一键启动 NapCat" aria-label="启动 NapCat" onClick={() => void invoke('qq.launchNapcat', { launcher: qqCfg.napcatLauncher, qq: qqCfg.napcatQq }, '正在启动 NapCat…')}><RefreshCw size={14} /></button>
              ) : null}
            </span>
          </div>;
        })()}
      </div></ErrorBoundary>
      <nav className="place-list" aria-label="房间">
      <button type="button" className={`room-entry ${view === 'room' ? 'selected' : ''} ${snapshot.room.state.active ? 'active' : ''}`} aria-current={view==='room'?'page':undefined} onClick={() => setView('room')}>
        <MessagesSquare size={16} /><span><strong>茶歇室</strong><small>{snapshot.room.state.active ? `${team.get(snapshot.room.state.speaking)?.name ?? '大家'} 正在说话…` : snapshot.room.messages.length ? `${snapshot.room.messages.length} 条消息` : '闲聊或开会，不绑定项目'}</small></span>
        {snapshot.room.state.active && <span className="status-dot active" />}
      </button>
      <button type="button" className={'room-entry '+(view==='roundtable'?'selected':'')} aria-current={view==='roundtable'?'page':undefined} onClick={()=>{setView('roundtable');setSessionId('');}}><Users size={16}/><span><strong>圆桌</strong><small>{snapshot.roundtable?.topics.length?snapshot.roundtable.topics.length+' 个议题':'独立评审、比稿与方案比较'}</small></span></button>
      <AttentionEntry summary={snapshot.attention} onOpen={openAttention} onIgnore={item=>invoke('attention.dismiss',{id:item.id,fingerprint:item.fingerprint})} />
      </nav>

      <div className="sidebar-section-label"><span>项目</span><IconButton label="添加项目" onClick={() => setModal('project')} disabled={!snapshot.backendReady}><Plus size={15} /></IconButton></div>
      <ErrorBoundary area="项目和会话列表" compact resetKey={projectId}><div className="project-list" role="tree" aria-label="项目树">
        {workProjects.length === 0 ? <div className="sidebar-empty">还没有项目，先添加一个吧</div> : projectRows(workProjects,collapsedProjects).map(({project:item,depth,hasChildren,path:treePath}) => renaming?.kind === 'project' && renaming.id === item.id
          ? <RenameInput key={item.id} value={renaming.value} label="项目名称" onChange={value => setRenaming({ ...renaming, value })} onCommit={() => void commitRename()} onCancel={() => setRenaming(null)} />
          : <div className={`list-row project-item project-tree-row ${item.id === projectId ? (view === 'project' ? 'selected current' : 'current') : ''}`} key={item.id} role="treeitem" aria-level={depth+1}
            draggable={snapshot.backendReady} data-project-drop={projectDrop?.id===item.id?projectDrop.position:undefined}
            onDragStart={event=>{draggingProject.current=item;event.dataTransfer.setData('text/plain',item.name);event.dataTransfer.effectAllowed='move';}}
            onDragEnd={()=>{draggingProject.current=null;setProjectDrop(undefined);}}
            onDragOver={event=>{
              const source=draggingProject.current;
              if(!source||source.id===item.id||source.parentId!==item.parentId){setProjectDrop(old=>old?undefined:old);return;}
              event.preventDefault();event.dataTransfer.dropEffect='move';
              const bounds=event.currentTarget.getBoundingClientRect();
              const position=event.clientY<bounds.top+bounds.height/2?'before':'after';
              setProjectDrop(old=>old?.id===item.id&&old.position===position?old:{id:item.id,position});
            }}
            onDrop={event=>{
              const source=draggingProject.current;
              draggingProject.current=null;setProjectDrop(undefined);
              if(!source||source.id===item.id||source.parentId!==item.parentId)return;
              const bounds=event.currentTarget.getBoundingClientRect();
              event.preventDefault();
              void reorderProject(source,item,event.clientY<bounds.top+bounds.height/2?'before':'after');
            }}
            onKeyDown={event=>{
              if(!snapshot.backendReady||!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;
              event.preventDefault();
              const siblings=projectRows(workProjects).map(row=>row.project).filter(p=>p.parentId===item.parentId);
              const up=event.key==='ArrowUp',index=siblings.findIndex(p=>p.id===item.id),target=siblings[index+(up?-1:1)];
              if(target)void reorderProject(item,target,up?'before':'after');
            }} aria-selected={item.id===projectId} aria-expanded={hasChildren?!collapsedProjects.has(item.id):undefined} style={{paddingLeft:Math.min(depth,6)*13}} onContextMenu={event => openMenu(event, projectMenuItems(item))}>
            {hasChildren?<button type="button" className="project-tree-toggle" aria-label={(collapsedProjects.has(item.id)?'展开':'收起')+' '+item.name+' 的子项目'} onClick={()=>setCollapsedProjects(old=>{const next=new Set(old);if(next.has(item.id))next.delete(item.id);else next.add(item.id);return next;})}>{collapsedProjects.has(item.id)?<ChevronRight size={13}/>:<ChevronDown size={13}/>}</button>:<span className="project-tree-spacer"/>}
            <button type="button" className="list-row-main" onClick={() => openProject(item)} onDoubleClick={() => { window.clearTimeout(inviteTimer.current); setRenaming({ kind: 'project', id: item.id, value: item.name }); }} title={treePath.join(' / ')+' · '+item.directory}>{item.id === projectId ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{item.name}</span></button>
            <button type="button" className="row-more" aria-label={`${item.name} 的更多操作`} onClick={event => openMenu(event, projectMenuItems(item))}><MoreHorizontal size={15} /></button>
          </div>)}
      </div>
      </ErrorBoundary>
      </div>

      <div className="sidebar-footer">
        <UserFooterMenu
          profile={snapshot.profile}
          backendReady={snapshot.backendReady}
          loaded={loaded}
          onSettings={openSettings}
          onQuota={() => setQuotaOpen(true)}
        />
      </div>
    </aside>

    <div className="workspace">
      {!snapshot.backendReady && loaded && <div className="backend-banner" role="status"><AlertCircle size={16} /><span>{backendMessage || '后端尚未就绪，连接恢复前不会发送任务。'}</span><button onClick={() => void refresh().catch(error => notify(errorText(error), true))}>重新连接</button>{window.fountain && <button disabled={restarting} onClick={() => void restartBackend()}>{restarting ? '正在重启…' : '重启后端'}</button>}</div>}
      {view==='roundtable'?<ErrorBoundary area="圆桌" resetKey={snapshot.roundtable?.currentTopicId}><RoundtableView snapshot={snapshot} invoke={invoke} request={roundtableRequest} onHandled={()=>setRoundtableRequest(undefined)} onProject={id=>{setProjectId(id);setView('project');setSessionId('');}}/></ErrorBoundary>:view==='reports'&&project?<ErrorBoundary area="个人汇报" resetKey={project.id+reportMemberId}><MemberReports key={project.id+':'+reportMemberId} project={project} memberId={reportMemberId} snapshot={snapshot} invoke={invoke} reports={reportEntries} onOpenReport={openReport} onMeeting={()=>setView('project')} onDesk={team.get(reportMemberId)?()=>openDesk(reportMemberId):undefined}/></ErrorBoundary>:view==='desk'?<ErrorBoundary area="个人工位" resetKey={deskMemberId}><MemberDesk key={deskMemberId} memberId={deskMemberId} snapshot={snapshot} invoke={invoke} onSettings={()=>openSettings('members',deskMemberId)}/></ErrorBoundary>:view === 'project' && project ? <ErrorBoundary area="项目会议室" resetKey={project.id}><ProjectRoom onOpenAttention={openAttention} key={project.id} snapshot={snapshot} project={project} invoke={invoke} reports={reportEntries} onOpenReport={openReport}onRoundtable={source=>{setRoundtableRequest('topicId' in source?{topicId:source.topicId,nonce:Date.now()}:{projectId:project.id,source,nonce:Date.now()});setView('roundtable');setSessionId('');}} onOpenSession={(id,repair) => {if(repair){setProjectId(repair.targetProjectId);setReportMemberId(repair.memberId);setView('reports');setSessionId('');return;}const target=snapshot.sessions.find(s=>s.id===id);if(target)openRecordedSession(target);}} /></ErrorBoundary>
        : view === 'room' ? <ErrorBoundary area="聊天室" resetKey={snapshot.room.currentThreadId}><RoomView snapshot={snapshot} invoke={invoke} focus={roomFocus} onOpenSession={(target, id) => { const recorded=snapshot.sessions.find(s=>s.id===id);if(recorded)openRecordedSession(recorded); }} /></ErrorBoundary> : <ErrorBoundary area="主页" resetKey={projectId}><Welcome project={project} snapshot={snapshot} team={team} moods={moods} invoke={invoke} onSettingsTab={(tab, focus) => openSettings(tab, null, focus ?? null)} onProject={() => setModal('project')} onCard={openMemberCard} onCollaboration={() => openCollaboration()} /></ErrorBoundary>}
    </div>
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'} key={toast.id}>{toast.error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}<span>{toast.text}</span><IconButton label="关闭提示" onClick={() => setToast(null)}><X size={14} /></IconButton></div>}
    {hierarchy&&<ProjectHierarchyModal key={hierarchy.mode+hierarchy.target.id} {...hierarchy} snapshot={snapshot} invoke={invoke} onClose={()=>setHierarchy(undefined)} onCreate={createdProject} onSaved={async()=>{await refresh();notify('项目归属与修改范围已保存。');}}/>}
    {modal && <ErrorBoundary area={modal === 'settings' ? '设置' : modal === 'project' ? '添加项目' : modal === 'session' ? '新建会话' : modal === 'invite' ? '请大家一起来' : '协作'} onDismiss={() => setModal(null)}>
      {modal === 'project' && <ProjectModal invoke={invoke} onClose={() => setModal(null)} onCreate={createdProject} />}
      {modal === 'settings' && <SettingsModal sharedUsage={hudUsage} snapshot={snapshot} invoke={invoke} onClose={() => setModal(null)} notify={notify} installs={installs} onInstall={onInstall} theme={theme} onTheme={setTheme} initialTab={settingsTab} initialFocus={settingsFocus} initialEditing={settingsEditing} />}
      {modal === 'invite' && <InviteModal snapshot={snapshot} invoke={invoke} initialProjectId={inviteProject} onClose={() => setModal(null)} onCreateProject={createdInviteProject} onDone={enterMeeting} />}

    </ErrorBoundary>}
    {memberStop&&<Modal title={'中止 '+(team.get(memberStop.memberId)?.name??'这位成员')} subtitle={'将停止 '+memberStop.runs.length+' 项当前运行，其他成员保留。'} onClose={()=>{if(!memberStopping)setMemberStop(undefined);}}><div className="modal-body"><ul>{memberStop.runs.map(run=><li key={run.runId}><strong>{run.location}{run.projectName?' · '+run.projectName:''}</strong><p>{run.title}</p></li>)}</ul><p>已保存的发言和文件版本保留；结果未知的请求不会自动重发。</p>{memberStopError&&<p role="alert" className="task-meta bad">{memberStopError}</p>}</div><div className="modal-footer"><button className="button quiet" disabled={memberStopping} onClick={()=>setMemberStop(undefined)}>取消</button><button className="button danger" disabled={memberStopping||!memberStop.runs.length} onClick={()=>void confirmMemberStop()}>确认中止这位成员</button></div></Modal>}
    {quotaOpen&&<QuotaOverview sharedUsage={hudUsage} snapshot={snapshot} invoke={invoke} onClose={()=>setQuotaOpen(false)}/>}
    {automationOpen&&<AutomationPanel snapshot={snapshot} invoke={invoke} notify={notify} onClose={()=>setAutomationOpen(false)}/>}
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    {memberCard && (() => {
      const target = memberCard, status = memberStatus(target.memberId), executor = team.get(target.memberId)?.executor;
      const go = (action: () => void) => () => { closeMemberCard(); action(); };
      return <MemberCard sharedUsage={sharedUsageFor(hudUsage, target.memberId, snapshot.settings.claudeAuthMode === 'api')} target={target} snapshot={snapshot} status={status} onClose={closeMemberCard}
        onOpenWork={go(() => { if (status.inRoom) setView('room'); else if (status.session) openRecordedSession(status.session); })}
        onDesk={go(()=>openDesk(target.memberId))} onConnect={go(() => openSettings('members', null, executor ?? null))} />;
    })()}
    {switcher && <QuickSwitcher
      snapshot={snapshot}
      firstInput={firstInput}
      commands={([
        ...(view === 'project' ? [
          { id: 'proj-code', title: '打开代码变更与文件树', subtitle: '查看 Git Diff、行级批注返工与文件树', keywords: 'git diff files code 代码 变更 文件', shortcut: 'Ctrl+Shift+G', icon: <GitBranch size={15} />, run: () => window.dispatchEvent(new CustomEvent('fountain:cmd', { detail: 'open-code' })) },
          { id: 'proj-scripts', title: '打开项目脚本运行器', subtitle: '一键运行 npm scripts / 测试，报错直发成员修', keywords: 'script terminal run test build 脚本 终端', shortcut: 'Ctrl+J', icon: <Terminal size={15} />, run: () => window.dispatchEvent(new CustomEvent('fountain:cmd', { detail: 'toggle-scripts' })) },
          { id: 'proj-sdd', title: '打开 SDD / 双盲规范立项', subtitle: '宪法 → Spec → 双盲 Plan 对照 → 自动 Tasks', keywords: 'sdd spec blind plan 双盲 规范', shortcut: 'Ctrl+Shift+S', icon: <GitCompareArrows size={15} />, run: () => window.dispatchEvent(new CustomEvent('fountain:cmd', { detail: 'open-sdd' })) },
          { id: 'proj-fanout', title: '发起同题并行盲写比稿 (Fan-out)', subtitle: '多成员在独立副本并行写代码，横向对比 Diff 择优写回', keywords: 'fanout parallel bakeoff 并行 盲写 比稿 orca', shortcut: 'Ctrl+Shift+F', icon: <Sparkles size={15} />, run: () => window.dispatchEvent(new CustomEvent('fountain:cmd', { detail: 'open-fanout' })) },
          { id: 'proj-checkpoint', title: '创建安全检查点 (Checkpoint)', subtitle: 'T3 风格隐式 Git 快照，不污染提交历史', keywords: 'checkpoint snapshot save 快照 检查点 回滚', icon: <History size={15} />, run: () => window.dispatchEvent(new CustomEvent('fountain:cmd', { detail: 'create-checkpoint' })) },
          { id: 'proj-board', title: '展开 / 收起右侧工作区', subtitle: '扩大聊天区域或呼出右侧面板', keywords: 'panel sidebar board 看板 右侧栏', shortcut: 'Ctrl+B', icon: <PanelRightClose size={15} />, run: () => window.dispatchEvent(new CustomEvent('fountain:cmd', { detail: 'toggle-board' })) },
        ] : []),
        { id: 'self-heal-software', title: '软件自修：把最近报错交给成员修复 FountAIn', subtitle: '自动收集最近失败运行与报错日志，按“谁出问题谁负责”派发到 FountAIn 源码项目', keywords: 'selfheal bug fix repair 自修 报错 修复 软件 排障', icon: <Wrench size={15} />, run: () => {
          void invoke<{ targetProjectId: string; targetProjectName: string; memberName: string; memberId: string; isSoftwareRepo: boolean }>('project.selfHeal.dispatch', { projectId: project?.id, scope: 'software' })
            .then(res => {
              notify(`已将软件自修工单派发给 ${res.memberName}（${res.targetProjectName}）。`);
              setProjectId(res.targetProjectId);
              setReportMemberId(res.memberId);
              setView('reports');
            })
            .catch(err => notify(errorText(err), true));
        } },
        { id: 'new-project', title: '新建项目', subtitle: '关联本地代码目录或课程任务房', keywords: 'create project folder 新建 项目', icon: <Plus size={15} />, run: () => setModal('project') },
        { id: 'open-automation', title: '自动功能与定时任务', subtitle: '管理定时巡检与自动运行任务', keywords: 'automation schedule cron 定时 自动', icon: <CalendarClock size={15} />, run: () => setAutomationOpen(true) },
        { id: 'open-quota', title: '查看用量与额度', subtitle: '检查各模型账号余额与配额状态', keywords: 'quota billing usage 额度 用量', icon: <Activity size={15} />, run: () => setQuotaOpen(true) },
        { id: 'toggle-theme', title: theme === 'dark' ? '切换为浅色主题' : '切换为深色主题', subtitle: '即时切换界面明暗外观', keywords: 'theme dark light 主题 深色 浅色', icon: theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />, run: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')) },
        { id: 'open-settings', title: '打开设置', subtitle: '模型连接、团队角色、权限与备份', keywords: 'settings config preferences 设置 配置', shortcut: 'Ctrl+,', icon: <Settings2 size={15} />, run: () => openSettings('connections') },
      ] as CommandPaletteAction[])}
      onClose={() => setSwitcher(false)}
      onPick={target => {
      setSwitcher(false);
      if (target.kind === 'session') openRecordedSession(target.session);
      else if (target.kind === 'project') openProject(target.project);
      else if (target.kind === 'desk') openDesk(target.memberId);
      else if (target.kind === 'room') setView('room');
      else if (target.kind === 'roundtable') {
        if (target.topicId) setRoundtableRequest({ topicId: target.topicId, nonce: Date.now() });
        setView('roundtable');
        setSessionId('');
      }
    }} />}
    {confirm && (() => {
      const target = confirm.kind === 'remove-project' ? undefined : snapshot.sessions.find(item => item.id === confirm.id);
      const targetProject = confirm.kind === 'remove-project' ? snapshot.projects.find(item => item.id === confirm.id) : undefined;
      const copies = confirm.kind === 'remove-project' ? snapshot.sessions.filter(item => item.projectId === confirm.id && item.workspaceKind && item.workspaceKind !== 'original' && item.workspace).length : target?.workspace && target.workspaceKind !== 'original' ? 1 : 0;
      const name = target ? sessionTitle(target, firstInput(target.id)) : targetProject?.name ?? '';
      const heading = confirm.kind === 'delete-session' ? '删除这个会话？' : confirm.kind === 'remove-project' ? '把项目从工作室移除？' : '丢弃这个工作副本？';
      return <Modal title={heading} subtitle={name} onClose={() => setConfirm(null)}>
        <div className="modal-body">
          {confirm.kind === 'delete-session' && <p className="confirm-text">对话记录、任务记录和待回应的请求会一起删除，不能恢复。如果只是不想看到它，可以改用“归档”。</p>}
          {confirm.kind === 'remove-project' && <p className="confirm-text">这个项目里的 {snapshot.sessions.filter(item => item.projectId === confirm.id).length} 个会话会一起删除。<strong>你电脑上的项目文件夹不会被改动。</strong></p>}
          {confirm.kind === 'discard' && <p className="confirm-text">工作副本里还没应用到项目的改动会丢失。项目本身不受影响；下一轮任务会从项目当前的样子重新建立副本。如果需要保留改动，请先“应用到项目”。</p>}
          {confirm.kind !== 'discard' && copies > 0 && <label className="toggle-row"><span><strong>同时删除工作副本（{copies} 个）</strong><small>未应用到项目的改动会丢失。不勾选则保留在 FountAIn 的数据目录里。</small></span><input type="checkbox" checked={confirm.discard} onChange={event => setConfirm({ ...confirm, discard: event.target.checked })} /></label>}
        </div>
        <div className="modal-footer"><button className="button quiet" onClick={() => setConfirm(null)}>取消</button><button className="button danger-solid" onClick={() => void runConfirm()}><Trash2 size={14} />{confirm.kind === 'delete-session' ? '删除会话' : confirm.kind === 'remove-project' ? '移除项目' : '丢弃副本'}</button></div>
      </Modal>;
    })()}
    <LaunchSplash ready={loaded && snapshot.backendReady} />
  </div></div></RoundtableNavigation.Provider></TeamProvider>;
}

function UserFooterMenu({ profile, backendReady, loaded, onSettings, onQuota }: {
  profile: Snapshot['profile']; backendReady: boolean; loaded: boolean;
  onSettings: (tab: SettingsTab) => void; onQuota: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const displayName = profile.name?.trim() || '我';
  const statusText = backendReady ? '本机工作台已连接' : loaded ? '后端未连接' : '正在连接…';
  const go = (fn: () => void) => { setOpen(false); fn(); };
  return <div className="user-footer-wrap" ref={wrapRef}>
    {open && <div className="user-footer-popover" role="menu" aria-label="用户与设置菜单">
      <div className="user-popover-head">
        <UserAvatar name={displayName} avatar={profile.avatar} size={38} />
        <div className="user-popover-meta">
          <strong>{displayName}</strong>
          <small className={backendReady ? 'ready' : ''}><span className="status-dot" />{statusText}</small>
        </div>
      </div>
      <div className="user-popover-list">
        <button type="button" role="menuitem" onClick={() => go(() => onSettings('profile'))}><IdCard size={14} /><span>个人资料与称呼</span></button>
        <button type="button" role="menuitem" onClick={() => go(() => onSettings('members'))}><Users size={14} /><span>团队成员与人物卡</span></button>
        <button type="button" role="menuitem" onClick={() => go(() => onSettings('connections'))}><Settings2 size={14} /><span>连接与模型设置</span></button>
        <button type="button" role="menuitem" onClick={() => go(onQuota)}><Activity size={14} /><span>用量与额度</span></button>
        <div className="user-popover-sep" />
        <button type="button" role="menuitem" onClick={() => go(() => onSettings('workspace'))}><Globe2 size={14} /><span>外观与工作台设置</span></button>
      </div>
    </div>}
    <button type="button" className={`user-footer-btn ${open ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span className="user-footer-avatar-wrap">
        <UserAvatar name={displayName} avatar={profile.avatar} size={32} />
        <span className={`user-footer-dot ${backendReady ? 'ready' : ''}`} aria-hidden="true" />
      </span>
      <span className="user-footer-info">
        <strong>{displayName}</strong>
        <small>{statusText}</small>
      </span>
      <Settings2 size={15} className="user-footer-gear" />
    </button>
  </div>;
}

function WindowTitleBar({ invoke }: { invoke: Invoke }) {
  const [winState, setWinState] = useState({ maximized: false, fullScreen: false });
  const sync = useCallback(() => {
    void invoke<{ maximized: boolean; fullScreen: boolean }>('window.control', { action: 'state' })
      .then(res => { if (res) setWinState(res); })
      .catch(() => {});
  }, [invoke]);
  useEffect(() => {
    sync();
    let timer = 0;
    const onResize = () => { window.clearTimeout(timer); timer = window.setTimeout(sync, 80); };
    window.addEventListener('resize', onResize);
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', onResize); };
  }, [sync]);
  useEffect(() => {
    document.body.classList.toggle('is-fullscreen', winState.fullScreen);
    return () => document.body.classList.remove('is-fullscreen');
  }, [winState.fullScreen]);
  if (winState.fullScreen) return null;
  const run = (action: 'minimize' | 'toggleMaximize' | 'toggleFullscreen' | 'close') => {
    void invoke<{ maximized: boolean; fullScreen: boolean }>('window.control', { action })
      .then(res => { if (res) setWinState(res); })
      .catch(() => {});
  };
  return <header className="app-titlebar" onDoubleClick={() => run('toggleMaximize')}>
    <div className="app-titlebar-drag" />
    <div className="app-titlebar-controls">
      <button type="button" className="app-win-btn" title="全屏 (F11)" aria-label="切换全屏" onClick={() => run('toggleFullscreen')}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25"><path d="M1.5 4.5V1.5h3M7.5 1.5h3v3M10.5 7.5v3h-3M4.5 10.5h-3v-3" /></svg>
      </button>
      <button type="button" className="app-win-btn" title="最小化" aria-label="最小化" onClick={() => run('minimize')}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25"><path d="M2 6h8" /></svg>
      </button>
      <button type="button" className="app-win-btn" title={winState.maximized ? '还原' : '最大化'} aria-label={winState.maximized ? '还原窗口' : '最大化窗口'} onClick={() => run('toggleMaximize')}>
        {winState.maximized
          ? <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="3.5" width="6.5" height="6.5" rx="0.8" /><path d="M4 3.5V2.3a.8.8 0 0 1 .8-.8h5a.8.8 0 0 1 .8.8v5a.8.8 0 0 1-.8.8H8.5" /></svg>
          : <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="2" width="8" height="8" rx="0.8" /></svg>}
      </button>
      <button type="button" className="app-win-btn close" title="隐藏到托盘" aria-label="关闭窗口" onClick={() => run('close')}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
      </button>
    </div>
  </header>;
}

function RenameInput({ value, label, onChange, onCommit, onCancel }: { value: string; label: string; onChange: (value: string) => void; onCommit: () => void; onCancel: () => void }) {
  return <input className="rename-input" aria-label={label} value={value} autoFocus maxLength={120} onFocus={event => event.target.select()} onChange={event => onChange(event.target.value)} onBlur={onCommit}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onCommit(); } else if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }} />;
}

function Welcome({ project, snapshot, team, moods, invoke, onProject, onSettingsTab, onCard, onCollaboration }: {
  project?: Project; snapshot: Snapshot; team: Team; moods: Record<string, Mood>; invoke: Invoke; onSettingsTab: (tab: SettingsTab, focus?: string) => void; onProject: () => void;
  onCard: (memberId: string, anchor: Element) => void; onCollaboration: () => void;
}) {
  const ready = (member: TeamMember) => runnable(snapshot.providers.find(item => item.id === member.executor));
  const visible=team.members.filter(member=>!member.card.cardHidden),readyCount=team.members.filter(ready).length;
  const readyNames = visible.filter(ready).map(member => member.name);
  return <div className="studio-welcome">
    <RoomBackdrop />
    <div className="welcome-hero">
      <h1 className="welcome-greeting-title">
        <svg className="welcome-greeting-logo" viewBox="0 0 40 40" width="34" height="34" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <circle cx="20" cy="6.6" r="5.5" fill="#4b7cf5" />
          <circle cx="8.4" cy="26.7" r="5.5" fill="#7f76e0" />
          <circle cx="31.6" cy="26.7" r="5.5" fill="#ab60e6" />
          <circle cx="20" cy="20" r="5.7" fill="#ee7a3e" />
        </svg>
        <span>{greeting()}{snapshot.profile.name?.trim() ? ` · ${snapshot.profile.name.trim()}` : ''}</span>
      </h1>
      {!readyNames.length && <p className="welcome-description">{!visible.length&&team.members.length?'人物卡已隐藏。可以在设置中重新显示，已有对话和连接照常使用。':'先在设置里添加人物卡并把成员连接好，大家就能开工了。'}</p>}
      <div className="welcome-buttons">
        <button className={`button ${snapshot.projects.some(item => !item.kind) ? 'secondary' : 'primary'}`} disabled={!snapshot.backendReady || readyCount < 2} title={readyCount < 2 ? '至少需要两位已准备好的成员' : '选一个项目，请大家进入它的会议室'} onClick={onCollaboration}><Users size={15} />请大家一起来</button>
        <button className="button secondary" onClick={()=>onSettingsTab('members')}><IdCard size={15}/>管理人物卡</button>
        {!project && !snapshot.projects.some(item => !item.kind) && <button className="button secondary" disabled={!snapshot.backendReady} onClick={onProject}><Plus size={16} />添加第一个项目</button>}
      </div>
    </div>
    {!snapshot.providers.some(info=>info.path||info.runtimeReady)&&!Object.values(snapshot.settings.paths).some(Boolean)&&!(snapshot.executors??[]).length&&<section className="catalog-first-use"><strong>开始使用：选择成员 → 下载官方程序 → 登录</strong><p>FountAIn 已带好下载所需的运行环境。选择想用的成员，由工作台下载并配置，再通过厂商官方页面或 API Key 登录。</p><button className="button primary" onClick={()=>onSettingsTab('members','catalog')}>选择并下载执行端</button></section>}
    <SetupChecklist snapshot={snapshot} team={team} invoke={invoke} onSettings={onSettingsTab} onProject={onProject} />
    <TarotStage members={visible} providers={snapshot.providers} moods={moods} onCard={onCard} />
    <div className="welcome-footer">
      <div className="welcome-decode" aria-label="FountAIn 品牌释义">
        <span><em>Fount</em> 发现</span>
        <i aria-hidden="true">·</i>
        <span><em>AI</em> 群智协同</span>
        <i aria-hidden="true">·</i>
        <span><em>n</em> 新灵感</span>
      </div>
      {readyNames.length > 0 && <div className="welcome-footer-sub">
        <p className="welcome-members-line">{readyNames.join(' · ')}</p>
        <p className="welcome-motto-line">思维如喷泉般涌现</p>
      </div>}
    </div>
    <div className="welcome-network-corner"><Globe2 size={11} /><span>{snapshot.settings.networkMode === 'tun' ? '网络沿用当前 TUN 环境' : '网络使用已配置的代理'} · 所有记录保存在本机</span></div>
  </div>;
}
