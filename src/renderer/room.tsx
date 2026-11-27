import {readableContent} from '../shared/content-presentation';
import { applyCostModeToConfig, classifyCostTier } from '../shared/cost-mode';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ArrowDown, BookmarkPlus, Columns2, Copy, Download, MoreHorizontal, Pencil, Reply, RotateCcw, Unlink, Eraser, FileStack, Layers, LoaderCircle, MessageSquarePlus, MessagesSquare, Send, SmilePlus, Sparkles, StopCircle, Trash2 } from 'lucide-react';
import type { Attachment, RoomHistory, RoomId, RoomMessage, RoomThread, Snapshot } from '../shared/types';
import type { PersonalRoomData } from '../shared/member-workspaces';
import { DEFAULT_ROOM_THREAD, ROOM_REACTIONS, isRoomPass, roomMarkerPending, roomMentions, roomReaction } from '../shared/room';
import { RoomPresence } from './discussion-status';
import { streamDiscussionBody } from '../shared/discussion-format';
import {hasMeetingRemarks,pendingDiscussionQuestion,pendingOwnerQuestions,type DiscussionStyle} from '../shared/discussion';
import {Modal} from './modals';
import { isSendKey } from './composer-keys';
import { RoomBackdrop } from './room-backdrop';
import { projectRelayRequest } from '../shared/project-relay';
import { MessageScrollRail } from './message-rail';
import { Markdown } from './Markdown';
import { Avatar, Portrait, UserAvatar, useTeam, type TeamMember } from './members';
import { copyText, runnable, time, type Invoke } from './ui';
import { NewTopicDialog, SummaryNote, TopicPanel, useSummarizer } from './topics';
import { HandoffDialog, RoomNote, type HandoffSource } from './handoff';
import { ContextMenu, type MenuItem, type MenuState } from './interactions';
import { MemoryProposalDialog } from './memory';
import { AttachButton, AttachmentList, AttachmentTray, useAttachments } from './attachments';
import { Briefcase } from 'lucide-react';
import { ImagePlus } from 'lucide-react';
import { GeneratedImages, ImageGenerationDialog } from './generated-images';
import { ErrorBoundary } from './ErrorBoundary';
import {mergeMemberReports} from '../shared/member-report-history';
import {useComposerDraft} from './composer-draft';
import { effectiveConfigText } from '../shared/executor-config';

const INVITED_KEY = 'fountain.room.invited';
/** Per topic: the newest message time the user has seen, for the divider shown on return. */
const SEEN_KEY = 'fountain.room.seen';
/** Whether the full-body portrait stage is shown alongside the chat; on by default. */
const STAGE_KEY = 'fountain.room.stage';
/** Reading buffer between AI turns in free chat (ms): 0, 6000, or 12000. */
const PACE_KEY = 'fountain.room.pace';
/** Finished member messages longer than this start folded. */
const isLong = (text: string) => text.length > 700 || text.split('\n').length > 14;
const SUGGESTIONS = ['大家今天过得怎么样？', '互相做个自我介绍吧', '开个会：下周我们一起做点什么？'];
/** Where the pending-items entry wants the room to show: a topic and, optionally, one message in it. */
export type RoomFocus = { threadId?: string; messageId?: string; nonce: number };
const mergeMessages = (...groups: RoomMessage[][]) => [...new Map(groups.flat().map(message => [message.id, message])).values()];

const QUESTION_STOP = /[？?。！!]+$/u;
/** Extract 1-click quick-choice suggestions from common A/B or yes/no member questions. */
function extractQuestionChoices(raw: string): string[] {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const colonIdx = Math.max(clean.lastIndexOf('：'), clean.lastIndexOf(':'));
  const body = colonIdx >= 0 && clean.length - colonIdx > 6 ? clean.slice(colonIdx + 1).trim() : clean;
  const trimmed = body.replace(QUESTION_STOP, '').trim();
  const orMatch = trimmed.match(/^(?:你是想|你希望|请问|请问是|是)?(.{2,60}?)[，,、\s]*还是\s*(.{2,60})$/u);
  if (orMatch) {
    const a = orMatch[1].replace(/^(?:先|直接)?是/u, '').trim();
    const b = orMatch[2].replace(/^(?:先|直接)?是/u, '').trim();
    if (a && b && a !== b) return [a, b];
  }
  if (/(?:是否|确认.{0,30}吗|可以吗|行吗|好吗|同意.{0,12}吗|要不要|需要.{0,16}吗)/u.test(clean)) {
    return ['可以，按这个来', '先等等，我补充一下'];
  }
  return [];
}

/** Reactions under a message; on members' messages in the current topic the user can add or remove theirs. */
function Reactions({ message, name, userAvatar, onToggle }: { message: RoomMessage; name: (author: string) => string; userAvatar?: string; onToggle?: (emoji: string) => void }) {
  const team = useTeam();
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const entries = Object.entries(message.reactions ?? {});
  if (!entries.length && !onToggle) return null;
  const pick = (emoji: string) => { setOpen(false); onToggle?.(emoji); };
  return <div className={`room-reactions ${entries.length ? '' : 'empty'}`}>
    {entries.map(([emoji, authors]) => {
      const who = authors.map(name).join('、'), mine = authors.includes('user');
      return <button type="button" key={emoji} className={`reaction-chip ${mine ? 'mine' : ''}`} disabled={!onToggle} title={who} aria-label={`${emoji} ${who}`} aria-pressed={onToggle ? mine : undefined} onClick={() => onToggle?.(emoji)}>
        <span className="reaction-emoji">{emoji}</span>
        <span className="reaction-faces">{authors.slice(0, 3).map(author => author === 'user' ? <UserAvatar key={author} name={name('user')} avatar={userAvatar} size={16} /> : <Avatar key={author} member={team.get(author)} id={author} size={16} ring={false} />)}</span>
        {authors.length > 3 && <small>{authors.length}</small>}
      </button>;
    })}
    {onToggle && <span className="reaction-add-wrap" ref={picker}>
      <button type="button" className="reaction-add" aria-label="添加表情回应" aria-expanded={open} title="添加表情回应" onClick={() => setOpen(value => !value)}><SmilePlus size={14} /></button>
      {open && <span className="reaction-picker" role="menu" aria-label="选择表情">{ROOM_REACTIONS.map(item => <button type="button" role="menuitem" key={item.emoji} title={item.label} aria-label={`回应 ${item.emoji} ${item.label}`} onClick={() => pick(item.emoji)}>{item.emoji}</button>)}</span>}
    </span>}
  </div>;
}

/** Task text for a project, quoting who said what in the room. */
const handoffText = (speaker: string, text: string) => `请根据茶歇室的讨论完成下面的任务。\n\n${speaker}：${text}`;

/** What a project's meeting room adds to the shared chat: its own people, cards for flow messages and a dock above the composer. */
export interface ProjectRoomChat {
  /** Who takes part (chosen in 请大家一起来); toggling a chip here changes it. */
  roster: string[]; onRoster: (memberIds: string[]) => void;
  onConfigureMember?: (memberId:string)=>void;
  onTaskRequest?:(memberId:string,goal:string,mode:'add'|'supplement')=>Promise<boolean>;
  /** The flow dock already shows a next step, so the discussion layer does not suggest another one. */
  flowNextStep?:boolean;
  /** A live card for a plan, decision or round-report message, or undefined to show the message as text. */
  renderFlow?: (message: RoomMessage) => ReactNode | undefined;
  /** Flow state that has no message of its own: drafting, stuck items, waiting for quota, choosing a lead. */
  dock?: ReactNode;
  empty?: ReactNode;
}
type RoomData = Snapshot['room'] & Partial<PersonalRoomData>;
/** `recordActions` lets the host put the record actions (compress, export) into its own topic menu,
 *  so the room shows one menu instead of a second tool row. */
export interface RoomSurface {title:string;hint:string;readOnly?:boolean;active?:boolean;renderMessage?:(message:RoomMessage,text:string)=>ReactNode|undefined;dock?:ReactNode;recordActions?:MutableRefObject<MenuItem[]>}
export interface PersonalRoomChat {
  kind:'desk'|'report'; memberId:string; title:string; hint:string;
  headerActions?:ReactNode; composerControls?:(room:RoomData)=>ReactNode;
  /** Report pages have no topics; this row takes the topic bar's place (e.g. the member switcher). */
  subbar?:ReactNode;
  renderMessage?:(message:RoomMessage)=>ReactNode|undefined;
  messageActions?:(message:RoomMessage,messages:RoomMessage[])=>ReactNode;
  dock?:ReactNode; empty?:ReactNode;
}

export function RoomView({ snapshot, invoke: rawInvoke, onOpenSession, onDocument, split, focus, roomId = 'global', project, personal,surface }: { snapshot: Snapshot; invoke: Invoke; onOpenSession?: (projectId: string, sessionId: string) => void; onDocument?: (target: string) => void; split?: { active: boolean; toggle: () => void }; focus?: RoomFocus; roomId?: RoomId; project?: ProjectRoomChat; personal?:PersonalRoomChat;surface?:RoomSurface }) {
  const global = roomId === 'global';
  // Every room call names its room; the tea room keeps the old unscoped form.
  const invoke = useCallback(<T,>(method: string, params?: unknown, success?: string) => rawInvoke<T>(method, global || !method.startsWith('room.') ? params : { ...(params as Record<string, unknown> | undefined), roomId }, success), [rawInvoke, global, roomId]) as Invoke;
  // The snapshot carries the tea room; another room is read on its own and re-read when its revision moves.
  const [loaded, setLoaded] = useState<RoomData | null>(null);
  const revision = snapshot.rooms?.find(item => item.roomId === roomId)?.revision;
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    if (global) return; let cancelled = false;
    void rawInvoke<RoomData>('room.get', { roomId }).then(result => { if (!cancelled && result?.state) setLoaded(result); }).catch(() => {});
    return () => { cancelled = true; };
  }, [global, roomId, revision, reloads]);
  useEffect(() => { if (!global) setLoaded(null); }, [roomId]);
  const expectedTopic=snapshot.rooms?.find(r=>r.roomId===roomId)?.currentThreadId;
  const expectedFolder=snapshot.rooms?.find(r=>r.roomId===roomId)?.folderKey;
  const personalLoading=Boolean(personal&&(!loaded||loaded.roomId!==roomId||expectedTopic!==undefined&&loaded.currentThreadId!==expectedTopic||expectedFolder!==undefined&&loaded.folderKey!==expectedFolder));
  const room: RoomData = global ? snapshot.room : (personalLoading?undefined:loaded) ?? { state: { active: false, mode: 'chat' }, messages: [], threads: [], hasMore: false } as unknown as RoomData;
  const personalSession=personal?.kind==='desk'?snapshot.sessions.find(s=>s.id===room.sessionId):undefined;
  const [handoff, setHandoff] = useState<HandoffSource | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [proposing, setProposing] = useState(false);
  const [stageOn, setStageOn] = useState<boolean>(() => { try { return localStorage.getItem(STAGE_KEY) !== 'off'; } catch { return true; } });
  const [focusedMemberId, setFocusedMemberId] = useState<string | undefined>(undefined);
  const toggleStage = () => setStageOn(value => { const next = !value; try { localStorage.setItem(STAGE_KEY, next ? 'on' : 'off'); } catch {} return next; });
  const [imageDialog,setImageDialog]=useState<{text:string;attachments:Attachment[];draftVersion:number}|null>(null);
  const team = useTeam(), { state } = room, profile = snapshot.profile;
  const historyOnly=Boolean(surface?.readOnly||personalSession?.restoredHistoryOnly||personal&&!snapshot.members.some(member=>member.id===personal.memberId));
  const ready = (executor: string) => runnable(snapshot.providers.find(item => item.id === executor));
  const imageProvider=snapshot.providers.find(info=>info.id==='codex');
  const canGenerateImage=ready('codex')&&imageProvider?.capabilities.imageGeneration===true&&snapshot.settings.permissions.codex.network;
  const [ownInvited, setOwnInvited] = useState<string[]>(() => {
    try { const saved = JSON.parse(localStorage.getItem(INVITED_KEY) ?? 'null'); if (Array.isArray(saved)) return saved.filter(id => typeof id === 'string'); } catch {}
    return team.members.filter(member => ready(member.executor)).map(member => member.id);
  });
  // A project room's people are the project's roster; the tea room remembers its own invitation.
  const invited = personal ? [personal.memberId] : project ? project.roster : ownInvited;
  const setInvited = (next: string[] | ((previous: string[]) => string[])) => { const value = typeof next === 'function' ? next(invited) : next; if (project) project.onRoster(value); else setOwnInvited(value); };
  const usable = invited.map(id => team.members.find(member => member.id === id)).filter((member): member is TeamMember => Boolean(member && ready(member.executor) && !state.restingMemberIds?.includes(member.id)));
  const [mode, setMode] = useState<'chat' | 'meeting'>('chat');
  const [paceMs, setPaceMs] = useState<number>(() => {
    try { const raw = Number(localStorage.getItem(PACE_KEY)); if ([0, 6000, 12000].includes(raw)) return raw; } catch {}
    return 6000;
  });
  const choosePace = (ms: number) => { setPaceMs(ms); try { localStorage.setItem(PACE_KEY, String(ms)); } catch {} };
  const discussion = state.mode === 'discuss' ? state.discussion : undefined;
  const ownerQuestions=pendingOwnerQuestions(discussion);
  const [questionDialog,setQuestionDialog]=useState<{discussionId:string;questionId?:string;memberId:string;quote?:RoomMessage;text:string}>();
  const [questionBusy,setQuestionBusy]=useState(false),[questionError,setQuestionError]=useState(''),[questionContextOpen,setQuestionContextOpen]=useState(false);
  const questionTextarea=useRef<HTMLTextAreaElement>(null);
  const canInterrupt=Boolean(discussion&&discussion.phase!=='idle'&&discussion.phase!=='summarizing'&&!discussion.interruption&&!discussion.unknownRunId&&!discussion.unknownRunIds?.length);
  const questionMembers=team.members.filter(member=>discussion?.members.includes(member.id)&&!state.restingMemberIds?.includes(member.id)&&!discussion.stoppedMembers?.includes(member.id)&&!discussion.skippedMembers?.[member.id]&&ready(member.executor));
  function openAnswer(questionId:string) {
    if(!discussion)return;
    setQuestionError('');setQuestionContextOpen(false);
    setQuestionDialog({discussionId:discussion.id,questionId,memberId:'',text:''});
  }
  function openInterruption(quote?:RoomMessage) {
    if(!discussion||!canInterrupt)return;
    setQuestionError('');setQuestionContextOpen(false);
    setQuestionDialog({discussionId:discussion.id,memberId:questionMembers.some(member=>member.id===quote?.author)?quote!.author:'',quote,text:''});
  }
  async function submitQuestion() {
    if(!questionDialog||!questionDialog.text.trim()||questionBusy)return;
    setQuestionBusy(true);setQuestionError('');
    try {
      const {discussionId,questionId,text,memberId,quote}=questionDialog;
      if(questionId){
        await invoke('room.question.answer',{discussionId,questionId,text});
        const remaining=ownerQuestions.filter(item=>item.id!==questionId);
        if(remaining.length){
          setQuestionContextOpen(false);
          setQuestionDialog({discussionId,questionId:remaining[0].id,memberId:'',text:''});
          requestAnimationFrame(()=>questionTextarea.current?.focus());
          return;
        }
      } else {
        await invoke('room.question.interrupt',{discussionId,text,memberId:memberId||null,replyTo:quote?.id});
      }
      setQuestionDialog(undefined);
    }catch(error){setQuestionError((error as Error).message);}
    finally{setQuestionBusy(false);}
  }
  const [handRaise, setHandRaise] = useState(false);
  const [hostPick,setHostPick]=useState(true);
  // 闲聊 is an open-ended chat without a budget; 开会 is a discussion that closes once the topic is handled.
  const style: DiscussionStyle = mode === 'chat' ? 'chat' : 'work';
  const [minutesDialog,setMinutesDialog]=useState<{discussionId:string;revision:number;memberId:string;interrupt:boolean}>(),[minutesBusy,setMinutesBusy]=useState(false),[minutesError,setMinutesError]=useState('');
  const minutesMembers=team.members.filter(m=>discussion?.members.includes(m.id)&&ready(m.executor));
  async function openMinutes(){if(!discussion)return;const saved=discussion;setMinutesBusy(true);setMinutesError('');try{let lead:string|undefined;if(roomId.startsWith('project:')){const data=await rawInvoke<{flow?:{leadMemberId:string};overview?:{stage?:{leadMemberId?:string}}}>('projectFlow.get',{projectId:roomId.slice(8)});lead=data.overview?.stage?.leadMemberId??data.flow?.leadMemberId;}const candidates=saved.members.filter(id=>minutesMembers.some(m=>m.id===id));setMinutesDialog({discussionId:saved.id,revision:saved.revision,memberId:lead&&candidates.includes(lead)?lead:candidates[0]??'',interrupt:state.active});}catch{}finally{setMinutesBusy(false);}}
  async function confirmMinutes(){if(!minutesDialog)return;setMinutesBusy(true);setMinutesError('');try{await invoke('room.minutes',{discussionId:minutesDialog.discussionId,revision:minutesDialog.revision,memberId:minutesDialog.memberId});setMinutesDialog(undefined);}catch(e){setMinutesError((e as Error).message);}finally{setMinutesBusy(false);}}
  useEffect(() => { if (discussion) { const chat = discussion.style === 'chat'; setMode(chat ? 'chat' : 'meeting'); setInvited([...new Set([...discussion.members,...(state.restingMemberIds ?? [])])]); setHandRaise(Boolean(discussion.handRaise));setHostPick(discussion.hostPick!==false); } }, [discussion?.id]);
  const [sending, setSending] = useState(false), [busy, setBusy] = useState(false),[stopping,setStopping]=useState(false);
  const [archiveId, setArchiveId] = useState<string>();
  const [panel, setPanel] = useState(false), [newTopic, setNewTopic] = useState<{ from?: RoomThread } | null>(null);
  // Anyone ready may write a summary, even if they are not invited to the current conversation.
  const writers = team.members.filter(member => ready(member.executor)&&(!personal||member.id===personal.memberId));
  const summarizer = useSummarizer(writers);
  const currentId = room.currentThreadId ?? (global ? DEFAULT_ROOM_THREAD : '');
  const noTopic=personal?.kind==='desk'&&!currentId;
  const selectedId = archiveId ?? currentId, archived = selectedId !== currentId;
  const composer=useComposerDraft(snapshot.dataDirectory,currentId&&!personalLoading?{roomId,threadId:currentId,restoreEpoch:snapshot.restoreEpoch}:undefined,rawInvoke);
  const draft=composer.value.text,setDraft=(text:string)=>composer.update(value=>({...value,text}));
  const typingInChat = !personal && mode === 'chat' && Boolean(draft.trim());
  useEffect(() => {
    if (personal || !snapshot.backendReady) return;
    void invoke('room.pace', { delayMs: paceMs, typing: typingInChat }).catch(() => {});
  }, [personal, snapshot.backendReady, paceMs, typingInChat, invoke]);
  useEffect(() => () => { if (!personal) void invoke('room.pace', { typing: false }).catch(() => {}); }, [personal, invoke]);
  const replyTo=composer.value.replyTo,setReplyTo=(id:string|undefined)=>composer.update(value=>({...value,replyTo:id}));
  const relayEnabled = global || roomId.startsWith('project:') || personal?.kind === 'report';
  function isRelay(text: string) {
    if (!relayEnabled) return false;
    if (/^\/back\s*$/i.test(text.trim())) return true;
    const projects = snapshot.projects.filter(item => !item.kind);
    try {
      return Boolean(projectRelayRequest(text, projects.flatMap(item => {
        const parent = projects.find(project => project.id === item.parentId);
        return parent ? [item, { id: item.id, name: parent.name + ' / ' + item.name }] : [item];
      }), snapshot.members, personal?.memberId));
    } catch { return true; }
  }
  const relayDraft = isRelay(draft);
  const workIntent=composer.value.workIntent??'ask',setWorkIntent=(value:'ask'|'add'|'supplement')=>composer.update(previous=>({...previous,workIntent:value}));
  const attach=useAttachments(invoke,[],{items:composer.value.attachments,update:change=>composer.update(value=>({...value,attachments:change(value.attachments)}))});
  // Only messages that arrive while a topic is open animate in; opening a room or paging history does not.
  const enterAfter = useMemo(() => new Date().toISOString(), [roomId, selectedId]);
  const enter = (message: RoomMessage) => message.at > enterAfter ? ' enter' : '';
  const threads = room.threads?.length ? room.threads : noTopic?[]:[{ id: currentId, title: '当前话题', createdAt: '' }];
  const thread = threads.find(item => item.id === selectedId);
  const [history, setHistory] = useState<RoomHistory | null>(null), [loading, setLoading] = useState(false);
  const request = useRef(0), loadingRef = useRef(false);
  useEffect(()=>{if(personal){++request.current;setHistory(null);setArchiveId(undefined);setNewTopic(null);}},[expectedFolder]);
  const list = useRef<HTMLDivElement>(null), textarea = useRef<HTMLTextAreaElement>(null), pinned = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  // Reading position: arrivals while scrolled up are counted, and on return a divider marks where the user left off.
  const seenKey = `${SEEN_KEY}:${currentId}`;
  const readSeen = () => { try { return localStorage.getItem(seenKey) ?? undefined; } catch { return undefined; } };
  const [unseen, setUnseen] = useState(0), [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dividerAt, setDividerAt] = useState<string | undefined>(readSeen);
  const newest = useRef<string | undefined>(undefined), jumped = useRef(false);
  const markSeen = () => { if (newest.current) try { localStorage.setItem(seenKey, newest.current); } catch {} };
  const page = history?.threadId === selectedId ? history : null;
  const messages = useMemo(() => {const result=archived ? page?.messages ?? [] : mergeMessages(page?.messages ?? [], room.messages);return personal?.kind==='report'?mergeMemberReports(result):personal?result.sort((a,b)=>a.at.localeCompare(b.at)||Number(a.author!=='user')-Number(b.author!=='user')||a.id.localeCompare(b.id)):result;}, [archived, page, room.messages, personal?.kind]);
  const hasMore = page?.hasMore ?? (!archived && Boolean(room.hasMore));
  const before = page ? page.before : archived ? undefined : room.before;
  const acknowledged=useRef<string|undefined>(undefined);
  const acknowledge=()=>{const token=room.readToken;if(personal&&token&&pinned.current&&!archived&&acknowledged.current!==token){acknowledged.current=token;void invoke('room.read',{readToken:token}).catch(()=>{acknowledged.current=undefined;});}};
  useEffect(()=>{acknowledge();},[room.readToken,archived]);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null), [mentionIndex, setMentionIndex] = useState(0);
  const mentionedWorker=project&&usable.find(m=>draft.includes('@'+m.name)||draft.includes('＠'+m.name));
  const candidates = mention ? usable.filter(member => member.name.toLowerCase().startsWith(mention.query.toLowerCase())) : [];
  const named = roomMentions(draft, team.members);
  const participants = named.ids.length ? named.ids.map(id => usable.find(member => member.id === id)).filter((member): member is TeamMember => Boolean(member)) : usable;

  useEffect(() => { if (global&&!personal) try { localStorage.setItem(INVITED_KEY, JSON.stringify(ownInvited)); } catch {} }, [ownInvited, global, Boolean(personal)]);
  async function loadHistory(older: boolean) {
    if (loadingRef.current || (older && (!hasMore || !before))) return;
    const revision = ++request.current;
    loadingRef.current = true; setLoading(true);
    if (older && list.current) { pinned.current = false; anchor.current = { height: list.current.scrollHeight, top: list.current.scrollTop }; }
    try {
      const result = await invoke<RoomHistory>('room.history', { threadId: selectedId, before: older ? before : undefined, limit: 100 });
      if (revision === request.current) setHistory(previous => ({ ...result, messages: older ? mergeMessages(result.messages, previous?.threadId === selectedId ? previous.messages : [], archived ? [] : room.messages) : result.messages }));
    } catch { if (revision === request.current) anchor.current = null; } finally { if (revision === request.current) { loadingRef.current = false; setLoading(false); } }
  }
  useEffect(() => {
    ++request.current; loadingRef.current = false; setLoading(false); setHistory(null); setMention(null); anchor.current = null; pinned.current = true;
    if (archived) void loadHistory(false);
    return () => { ++request.current; };
  }, [selectedId]);
  useEffect(() => { if (archiveId && !threads.some(item => item.id === archiveId)) setArchiveId(undefined); }, [archiveId, threads]);
  useEffect(() => {
    if (archived) return;
    if (!room.messages.length) { ++request.current; loadingRef.current = false; setLoading(false); setHistory(null); }
    else setHistory(previous => previous?.threadId === currentId ? { ...previous, messages: mergeMessages(previous.messages, room.messages) } : previous);
  }, [archived, currentId, room.messages]);
  useLayoutEffect(() => {
    if (anchor.current && list.current) { list.current.scrollTop = anchor.current.top + list.current.scrollHeight - anchor.current.height; anchor.current = null; }
  }, [messages]);
  const openedAtBottom=useRef('');
  useLayoutEffect(()=>{const key=roomId+':'+selectedId;if(personal&&messages.length&&list.current&&openedAtBottom.current!==key){openedAtBottom.current=key;pinned.current=true;list.current.scrollTop=list.current.scrollHeight;}},[roomId,selectedId,messages,Boolean(personal)]);

  const streamedBodies = useRef(new Map<string,{key:string;text:string}>());
  const { live, liveActivity } = useMemo(() => {
    const map = new Map<string, string>();
    type PlanStep = { text: string; status: 'completed' | 'in_progress' | 'pending' };
    const activityMap = new Map<string, {
      phaseLabel: string;
      waitingApproval: boolean;
      reasoning: string;
      steps: string[];
      plan: PlanStep[];
      lastEventAt?: string;
    }>();
    const parsePlanSteps = (event: Snapshot['events'][number]): PlanStep[] => {
      const data = event.data as any;
      const rawList =
        (Array.isArray(data?.input?.todos) && data.input.todos) ||
        (Array.isArray(data?.todos) && data.todos) ||
        (Array.isArray(data?.entries) && data.entries) ||
        (Array.isArray(data?.plan) && data.plan) ||
        null;
      if (rawList) {
        return rawList
          .map((item: any): PlanStep | null => {
            const rawStatus = String(item?.status ?? 'pending').toLowerCase();
            const status: PlanStep['status'] =
              rawStatus === 'completed' || rawStatus === 'done'
                ? 'completed'
                : rawStatus === 'in_progress' || rawStatus === 'inprogress' || rawStatus === 'running'
                  ? 'in_progress'
                  : 'pending';
            const label = String((status === 'in_progress' && item?.activeForm) || item?.content || item?.step || item?.title || '').trim();
            return label ? { text: label, status } : null;
          })
          .filter((x: PlanStep | null): x is PlanStep => Boolean(x))
          .slice(0, 12);
      }
      if (!event.text?.trim()) return [];
      return event.text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 10)
        .map((line): PlanStep => {
          if (/^(?:✓|✅|completed:|done:)/i.test(line)) return { text: line.replace(/^(?:✓|✅|completed:|done:)\s*/i, ''), status: 'completed' };
          if (/^(?:…|●|in_progress:|inprogress:)/i.test(line)) return { text: line.replace(/^(?:…|●|in_progress:|inprogress:)\s*/i, ''), status: 'in_progress' };
          return { text: line.replace(/^(?:·|○|-|\*|pending:)\s*/i, ''), status: 'pending' };
        })
        .filter(item => item.text.length > 0 && !item.text.startsWith('{') && !item.text.startsWith('['));
    };
    const friendlyToolLabel = (name?: string) => {
      const key = String(name ?? '').toLowerCase();
      if (/read|view|open|cat/.test(key)) return '正在查阅文件';
      if (/grep|glob|search|find|list/.test(key)) return '正在检索项目内容';
      if (/edit|write|patch|replace/.test(key)) return '正在编辑文件';
      if (/bash|shell|exec|command|terminal/.test(key)) return '正在运行脚本验证';
      if (/web|fetch/.test(key)) return '正在查阅资料';
      return '正在处理任务';
    };
    const retained = new Map<string,{key:string;text:string}>();
    for (const message of messages) if (message.status === 'speaking' && message.runId) {
      const events = snapshot.events.filter(event => event.runId === message.runId);
      const deltas = events.filter(event => event.kind === 'delta').map(event => event.text).join('');
      const raw = message.discussionId ? deltas || events.filter(event => event.kind === 'message' && (event.data as any)?.role !== 'user').at(-1)?.text || '' : deltas;
      const status = snapshot.runs.find(run => run.id === message.runId)?.status;
      const key = `${message.runId}:${message.discussionTurn??''}:${message.discussionRevision??''}`;
      const previous = streamedBodies.current.get(message.id);
      // Other rooms load messages separately. A completed snapshot can arrive before room.get's final message.
      // Carry only this exact turn's validated preview across that gap, never across a failure or a new run.
      const carry = !global && !raw && (status === 'ended' || status === 'completed') && previous?.key === key ? previous.text : '';
      const hidden = !global && status && ['stopping','stopped','interrupted','unknown','failed'].includes(status);
      const text = hidden ? '' : raw ? message.discussionId ? streamDiscussionBody(raw,message.discussionTurn,message.discussionRevision) : raw : carry;
      map.set(message.id,text);
      if (!hidden && !text) {
        const waitingApproval = snapshot.approvals.some(a => a.runId === message.runId && a.state === 'pending');
        const reasoning = events.filter(event => event.kind === 'reasoning').map(event => event.text).join('').trim();
        // Extract latest structured stage checklist (Claude TodoWrite / Codex plan / ACP plan / Cursor todos)
        const latestPlanEvent = events.filter(event => event.kind === 'plan').at(-1);
        const plan = latestPlanEvent ? parsePlanSteps(latestPlanEvent) : [];
        // Collect ONLY human-readable narration (model reasoning, intermediate prose, or human-written tool descriptions)
        // Never show raw tool_result / base64 / raw shell commands.
        const toolNotes = events
          .filter(event => event.kind === 'tool' && (event.data as any)?.type !== 'tool_result')
          .map(event => {
            const desc = (event.data as any)?.input?.description;
            return typeof desc === 'string' && desc.trim() && !desc.trim().startsWith('{') && !desc.trim().startsWith('[')
              ? desc.trim()
              : '';
          })
          .filter(Boolean);
        const dedupedNotes = toolNotes.filter((note, idx) => idx === 0 || note !== toolNotes[idx - 1]).slice(-60);
        const clippedReasoning = reasoning ? (reasoning.length > 1600 ? `…${reasoning.slice(-1600)}` : reasoning) : '';
        const lastToolUse = events.filter(event => event.kind === 'tool' && (event.data as any)?.type !== 'tool_result').at(-1);
        const lastEvent = events.filter(event => ['reasoning', 'tool', 'plan', 'delta', 'output'].includes(event.kind)).at(-1);
        const activePlanStep = plan.find(s => s.status === 'in_progress');
        const phaseLabel = waitingApproval
          ? '等待你批准操作'
          : activePlanStep
            ? '分阶段执行中'
            : lastEvent?.kind === 'tool'
              ? friendlyToolLabel((lastToolUse?.data as any)?.name ?? (lastToolUse?.data as any)?.tool)
              : reasoning
                ? '思考中'
                : deltas
                  ? '正在组织回复'
                  : '思考中';
        activityMap.set(message.id, {
          phaseLabel,
          waitingApproval,
          reasoning: clippedReasoning,
          steps: dedupedNotes,
          plan,
          lastEventAt: lastEvent?.at,
        });
      }
      if (!global) retained.set(message.id,{key,text});
    }
    streamedBodies.current = retained;
    return { live: map, liveActivity: activityMap };
  }, [global, messages, snapshot.approvals, snapshot.events, snapshot.runs]);
  const hasSpeaking = messages.some(message => message.status === 'speaking');
  const [speakingNow, setSpeakingNow] = useState(Date.now);
  useEffect(() => {
    if (!hasSpeaking) return;
    setSpeakingNow(Date.now());
    const timer = window.setInterval(() => setSpeakingNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasSpeaking]);
  const formatSeconds = (sec: number) => sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const elapsedSec = (at?: string) => {
    const start = at ? Date.parse(at) : NaN;
    return Number.isFinite(start) ? Math.max(0, Math.floor((speakingNow - start) / 1000)) : 0;
  };
  const lastLength = [...live.values()].join('').length + [...liveActivity.values()].map(a => a.reasoning.length + a.steps.length + a.plan.length).reduce((a, b) => a + b, 0) + messages.length;
  useEffect(() => {
    const node = list.current; if (!node) return;
    const toBottom = () => { if (pinned.current) node.scrollTop = node.scrollHeight; };
    const observer = new ResizeObserver(toBottom);
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    toBottom(); return () => observer.disconnect();
  }, [lastLength, selectedId, dividerAt]);
  // Only a real topic change re-reads the position; a repeated mount must not pick up what this view just stored.
  const shownThread = useRef(currentId);
  useEffect(() => {
    if (shownThread.current === currentId) return;
    shownThread.current = currentId; newest.current = undefined; jumped.current = false; setUnseen(0); setDividerAt(readSeen());
  }, [currentId]);
  useEffect(() => {
    if (archived || !messages.length) return;
    const latest = messages.reduce((top, message) => message.at > top ? message.at : top, ''), before = newest.current;
    if (!before || latest > before) newest.current = latest;
    if (before && !pinned.current) {
      const arrived = messages.filter(message => message.at > before && message.author !== 'user' && !message.discussionControl).length;
      if (arrived) setUnseen(count => count + arrived);
    }
    if (pinned.current) markSeen();
  }, [archived, messages]);
  const dividerIndex = !archived && dividerAt ? messages.findIndex(message => message.at > dividerAt && message.author !== 'user' && !message.discussionControl) : -1;
  // Opening the room with unread messages starts at the divider rather than the bottom.
  useLayoutEffect(() => {
    const node = list.current, divider = node?.querySelector<HTMLElement>('.room-new-divider');
    if (personal || jumped.current || !node || !divider) return;
    jumped.current = true;
    if (node.scrollHeight > node.clientHeight) { pinned.current = false; node.scrollTop += divider.getBoundingClientRect().top - node.getBoundingClientRect().top - 12; }
  }, [dividerIndex]);
  function jumpToLatest() {
    const node = list.current; if (!node) return;
    pinned.current = true; node.scrollTop = node.scrollHeight; setUnseen(0); markSeen();acknowledge();
  }
  // Opening a pending item: switch to its topic, then bring the message into view once it is loaded.
  const focusing = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!focus) return;
    setArchiveId(focus.threadId && focus.threadId !== currentId && threads.some(item => item.id === focus.threadId) ? focus.threadId : undefined);
    focusing.current = focus.messageId;
  }, [focus?.nonce]);
  useLayoutEffect(() => {
    const id = focusing.current, node = list.current; if (!id || !node) return;
    const target = node.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`); if (!target) return;
    focusing.current = undefined; pinned.current = false; jumped.current = true;
    target.scrollIntoView({ block: 'center' }); target.classList.remove('focus-flash'); void target.offsetWidth; target.classList.add('focus-flash');
  }, [messages, focus?.nonce]);
  const speaking = state.active ? team.get(state.speaking) : undefined;
  const compressing = state.compressing ? team.get(state.compressing) : undefined;
  const activeSpeaker = state.active && !compressing && !state.generatingImage
    ? (speaking ?? (personal ? team.get(personal.memberId) : undefined))
    : undefined;
  const midTurnMode = Boolean(activeSpeaker && !archived && !historyOnly && !ownerQuestions.length && !discussion?.interruption);
  const pendingFollowUps = state.pendingFollowUps ?? [];
  const current = threads.find(item => item.id === currentId) ?? { id: currentId, title: '当前话题', createdAt: '' };

  function toggle(id: string) { setInvited(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]); }
  function updateMention(value: string, caret: number) {
    const prefix = value.slice(0, caret), start = Math.max(prefix.lastIndexOf('@'), prefix.lastIndexOf('＠'));
    const query = prefix.slice(start + 1);
    setMention(start >= 0 && query.length <= 40 && !/[\n@＠，。！？,:;：；!?()[\]{}]/.test(query) ? { start, end: caret, query } : null);
    setMentionIndex(0);
  }
  function chooseMention(member: TeamMember) {
    if (!mention) return;
    const value = `${draft.slice(0, mention.start)}@${member.name} ${draft.slice(mention.end)}`;
    const caret = mention.start + member.name.length + 2;
    setDraft(value); setMention(null);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(caret, caret); });
  }
  async function sendMidTurn(midMode: 'queue' | 'immediate', text = draft) {
    const body = text.trim();
    if ((!body && !attach.items.length) || sending || busy || compressing || !activeSpeaker || archived || historyOnly || personalLoading || noTopic) return;
    const sentVersion = composer.version, submitted = { ...composer.value, text };
    setSending(true); pinned.current = true; setDividerAt(undefined);
    try {
      await invoke('room.midTurn', {
        mode: midMode,
        memberId: activeSpeaker.id,
        text: body,
        replyTo,
        ...(attach.items.length ? { attachments: attach.items } : {}),
      }, midMode === 'queue' ? `已排队，等 ${activeSpeaker.name} 说完后自动发送。` : undefined);
      composer.sent(submitted, sentVersion);
      setMention(null);
    } catch {} finally { setSending(false); }
  }
  async function promoteFollowUp(id: string) {
    if (sending || busy) return;
    setSending(true);
    try { await invoke('room.midTurn.promote', { id }); } catch {} finally { setSending(false); }
  }
  async function cancelFollowUp(id: string) {
    if (sending || busy) return;
    try { await invoke('room.midTurn.cancel', { id }); } catch {}
  }
  async function send(text = draft) {
    if (midTurnMode) return sendMidTurn('queue', text);
    const body = text.trim();
    if(ownerQuestions.length||discussion?.interruption)return;
    const sentVersion=composer.version,submitted={...composer.value,text};
    if(!isRelay(body)&&project?.onTaskRequest&&mentionedWorker&&workIntent!=='ask'){if(await project.onTaskRequest(mentionedWorker.id,body.replace('@'+mentionedWorker.name,'').replace('＠'+mentionedWorker.name,'').trim(),workIntent)){composer.sent(submitted,sentVersion);setMention(null);}return;}
    if ((!body && !attach.items.length) || sending || busy || compressing || (state.active && state.mode !== 'discuss') || archived || historyOnly || personalLoading || noTopic) return;
    setSending(true); pinned.current = true; setDividerAt(undefined);
    try { await invoke('room.send', { text: body, memberIds: usable.map(member => member.id), mode: 'discuss', style, maxMinutes: 0, handRaise: mode === 'meeting' && handRaise,hostPick, replyTo, ...(attach.items.length ? { attachments: attach.items } : {}) }); composer.sent(submitted,sentVersion); setMention(null); } catch {} finally { setSending(false); }
  }
  async function resumeDiscussion() {
    const acknowledgeUnknown = Boolean(discussion?.unknownRunId || discussion?.unknownRunIds?.length);
    if (acknowledgeUnknown && !window.confirm('上次执行结果未知。请先核对已收到的内容和活动记录。确认后将按当前讨论继续，不会重发原轮次。')) return;
    try { await invoke('room.resume', { acknowledgeUnknown, maxMinutes: 0, handRaise: mode === 'meeting' && handRaise,hostPick }); } catch {}
  }
  async function chooseHand(choice:'member'|'auto'|'skip',memberId?:string){
    if(busy||!discussion?.handRound||!(discussion.phase==='awaiting-host'||discussion.phase==='raising'&&discussion.hostPick&&discussion.handRound.status==='collecting'))return;
    setBusy(true);try{await invoke('room.host',{discussionId:discussion.id,revision:discussion.revision,handRoundId:discussion.handRound.id,choice,memberId});}catch{}finally{setBusy(false);}
  }
  async function endDiscussion() {
    if(!discussion||busy)return;
    const acknowledgeUnknown=Boolean(discussion.unknownRunId||discussion.unknownRunIds?.length);
    if(acknowledgeUnknown&&!window.confirm('上次执行结果未知。请先核对已收到的内容和活动记录。确认后结束本次讨论，不会重发原轮次。'))return;
    setBusy(true);
    try{await invoke('room.end',{discussionId:discussion.id,acknowledgeUnknown},'本次讨论已由你结束。');}catch{}finally{setBusy(false);}
  }
  const afterTopicChange = () => { setReloads(n => n + 1); ++request.current; loadingRef.current = false; setLoading(false); setHistory(null); setArchiveId(undefined); setMention(null); pinned.current = true; };
  async function manage(action: 'clear' | 'delete') {
    const question = action === 'delete' ? `删除归档话题「${thread?.title}」？这段记录将永久删除，当前话题不受影响。`
      : '清空当前话题？消息会删除，成员也会忘掉本话题。归档记录和项目会话保留。';
    if (!window.confirm(question)) return;
    setBusy(true);
    try { await invoke(`room.${action}`, action === 'delete' ? { threadId: selectedId } : undefined, action === 'delete' ? '归档话题已删除。' : '当前话题已清空。'); if(action==='clear')composer.clear(); afterTopicChange(); } catch {} finally { setBusy(false); }
  }
  async function compressCurrent() {
    if (!summarizer.member || !window.confirm(`让 ${summarizer.member.name} 把当前话题压缩成摘要？之后成员从摘要继续，消息仍然保留。这会使用一次成员额度。`)) return;
    setBusy(true);
    try { await invoke('room.compress', { threadId: currentId, memberId: summarizer.member.id }, '已压缩，成员接下来从摘要继续。'); pinned.current = true; } catch {} finally { setBusy(false); }
  }
  async function uninherit() {
    if (!thread?.inherited || !window.confirm(`不再延续「${thread.inherited.title}」？成员会只从本话题自己的内容继续，原来的话题记录不受影响。`)) return;
    setBusy(true);
    try { await invoke('room.uninherit', { threadId: thread.id }, '已不再延续之前的话题。'); } catch {} finally { setBusy(false); }
  }
  async function exportTopic(threadId = selectedId) {
    setBusy(true);
    try {
      const result = await invoke<{ title: string; content: string }>('room.export', { threadId });
      await invoke('file.save', { name: `FountAIn ${personal?personal.kind==='desk'?'工位':'汇报':'聊天室'} - ${result.title}.md`, content: result.content });
    } catch {} finally { setBusy(false); }
  }
  const name = (message: RoomMessage) => message.authorName ?? (message.author === 'user' ? profile.name || '你' : team.get(message.author)?.name ?? '成员');
  const quoteOptions=questionDialog&&!questionDialog.questionId ?
    [...new Map([...(questionDialog.quote?[questionDialog.quote]:[]),...messages.filter(message=>
      !message.discussionControl&&!message.contextOnly&&!message.system&&(message.author==='user'||message.status==='done')&&message.text.trim()).slice(-24).reverse()]
      .map(message=>[message.id,message])).values()] : [];
  const authorName = (author: string) => author === 'user' ? profile.name || '你' : team.get(author)?.name ?? '成员';
  // Less frequent message actions live in one menu, opened from "…" or by right-clicking the message.
  async function recallMessage(message: RoomMessage, edit: boolean) {
    if (!snapshot.backendReady || historyOnly || archived || personal) return;
    try {
      await invoke('room.recall', { messageId: message.id }, edit ? '已撤回，内容已放回输入框。' : '消息已撤回。');
      if (edit) {
        composer.update(previous => ({
          ...previous,
          text: message.text || previous.text,
          attachments: message.attachments?.length ? message.attachments : previous.attachments,
        }));
        requestAnimationFrame(() => textarea.current?.focus());
      }
    } catch {}
  }
  function quickMention(targetName: string) {
    if (archived || personal || !targetName) return;
    const tag = `@${targetName} `;
    composer.update(previous => {
      const already = previous.text.includes(`@${targetName}`) || previous.text.includes(`＠${targetName}`);
      if (already) return previous;
      const prefix = previous.text && !/\s$/.test(previous.text) ? `${previous.text} ` : previous.text;
      return { ...previous, text: `${prefix}${tag}` };
    });
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }
  function replyToMessage(message: RoomMessage) {
    const targetName = name(message);
    const mentionPrefix = !personal && message.author !== 'user' ? `@${targetName} ` : '';
    composer.update(previous => {
      const hasMention = mentionPrefix && (previous.text.includes(`@${targetName}`) || previous.text.includes(`＠${targetName}`));
      return {
        ...previous,
        replyTo: message.id,
        text: mentionPrefix && !hasMention ? `${mentionPrefix}${previous.text}` : previous.text,
      };
    });
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }
  function messageMenu(message: RoomMessage, canReply: boolean): MenuItem[] {
    const text = message.text, finished = message.author === 'user' || message.status === 'done';
    const canRecall = message.author === 'user' && !message.system && !historyOnly && !archived && !personal && snapshot.backendReady;
    return [
      { label: '复制文字', icon: <Copy size={14} />, disabled: !text, onSelect: () => { void copyText(text); } },
      ...(canRecall ? [
        { label: '撤回并重新编辑', icon: <Pencil size={14} />, onSelect: () => void recallMessage(message, true) },
        { label: '撤回消息', icon: <RotateCcw size={14} />, onSelect: () => void recallMessage(message, false) },
      ] : []),
      ...(canReply ? [{ label: '回复这条', icon: <Reply size={14} />, onSelect: () => replyToMessage(message) }] : []),
      ...(!personal&&!archived&&!historyOnly&&canInterrupt&&finished&&!message.contextOnly&&!message.discussionControl
        ? [{label:'打断并追问',icon:<MessageSquarePlus size={14}/>,onSelect:()=>openInterruption(message)}] : []),
      ...(global ? [{ label: '交给项目', icon: <Briefcase size={14} />, disabled: !text || !finished, onSelect: () => setHandoff({ threadId: selectedId, messageId: message.id, text: handoffText(name(message), text) }) }] : []),
    ];
  }
  const openMessageMenu = (event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]) => { event.preventDefault(); event.stopPropagation(); setMenu({ x: event.clientX, y: event.clientY, items }); };
  const moreButton = (message: RoomMessage, canReply: boolean) => <button type="button" className="icon-button room-more-button" aria-label={`${name(message)} 的消息操作`} title="更多操作" onClick={event => openMessageMenu(event, messageMenu(message, canReply))}><MoreHorizontal size={14} /></button>;
  async function react(message: RoomMessage, emoji: string) { try { await invoke('room.react', { messageId: message.id, emoji }); } catch {} }

  const autoCompressOn = snapshot.settings.autoCompressContext !== false;
  const autoCompressAvailable = !personal && !surface && (global || roomId.startsWith('project:'));
  const autoCompressName = team.get(snapshot.settings.autoCompressMemberId)?.name;
  const autoCompressLabel = '自动压缩设置 · ' + (autoCompressOn ? autoCompressName ?? (snapshot.settings.autoCompressMemberId ? '管理员不可用' : '自动选人') : '已关闭');
  const [autoCompressDialog,setAutoCompressDialog]=useState<{enabled:boolean;memberId:string}>();
  const [savingAutoCompress,setSavingAutoCompress]=useState(false);
  const [autoCompressError,setAutoCompressError]=useState('');
  function openAutoCompress() {
    setAutoCompressError('');
    setAutoCompressDialog({enabled:autoCompressOn,memberId:snapshot.settings.autoCompressMemberId??''});
  }
  async function saveAutoCompress() {
    if(!autoCompressDialog)return;
    setSavingAutoCompress(true);setAutoCompressError('');
    try {
      await invoke('room.autoCompress',{enabled:autoCompressDialog.enabled,memberId:autoCompressDialog.memberId||null},'自动压缩设置已保存。');
      setAutoCompressDialog(undefined);
    }catch(error){setAutoCompressError((error as Error).message);}
    finally{setSavingAutoCompress(false);}
  }
  const recordItems: MenuItem[] = [
    ...(messages.length > 0 ? [{ label: '压缩上下文', icon: <Sparkles size={14} />, disabled: busy || state.active || Boolean(compressing) || !summarizer.member || !snapshot.backendReady || Boolean(surface?.readOnly), onSelect: () => void compressCurrent() }] : []),
    ...(autoCompressAvailable ? [{ label: autoCompressLabel, icon: <Sparkles size={14} />, disabled: !snapshot.backendReady, onSelect: openAutoCompress }] : []),
    { label: '导出会议记录', icon: <Download size={14} />, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void exportTopic() },
    ...(surface ? [] : ['separator' as const, { label: '清空会议记录', icon: <Eraser size={14} />, danger: true, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void manage('clear') }]),
  ];
  if (surface?.recordActions) surface.recordActions.current = recordItems;
  const Root = project || personal ? 'section' : 'main';
  async function selectTopic(id:string){if(personal){try{await invoke('room.select',{threadId:id});afterTopicChange();}catch{}}else setArchiveId(id===currentId?undefined:id);}
  const stageCast = useMemo<TeamMember[]>(() => {
    if (personal) { const target = team.get(personal.memberId); return target ? [target] : []; }
    const ids = invited.length ? invited : team.members.map(member => member.id);
    const listMembers = ids.map(id => team.get(id)).filter((member): member is TeamMember => Boolean(member));
    return listMembers.length ? listMembers : team.members;
  }, [personal?.memberId, invited, team]);
  const lastAiSpeakerId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; --i) {
      const m = messages[i];
      if (!m.system && !m.contextOnly && !m.discussionControl && m.author !== 'user' && m.author !== 'system') return m.author;
    }
    return undefined;
  }, [messages]);
  const spotlight: TeamMember | undefined = useMemo(() => {
    if (personal) return stageCast[0];
    if (speaking) return speaking;
    if (focusedMemberId) { const chosen = stageCast.find(member => member.id === focusedMemberId); if (chosen) return chosen; }
    if (lastAiSpeakerId) { const recent = stageCast.find(member => member.id === lastAiSpeakerId) ?? team.get(lastAiSpeakerId); if (recent) return recent; }
    return stageCast[0];
  }, [personal, stageCast, speaking, focusedMemberId, lastAiSpeakerId, team]);
  const presenceModels = useMemo(() => {
    const map: Record<string, { short: string; full: string }> = {};
    const costLabels: Record<string, string> = { normal: '全勤', economy: '智能省流', on_demand: '按需' };
    const isMeetingNow = discussion && discussion.phase !== 'idle' ? discussion.style !== 'chat' : mode === 'meeting';
    const tier = classifyCostTier({ isCasualRoom: true, isMeeting: isMeetingNow });
    const shorten = (model: string) => {
      const m = model.toLowerCase();
      if (m.includes('fable')) return 'fable';
      if (m.includes('opus')) return 'opus';
      if (m.includes('sonnet')) return 'sonnet';
      if (m.includes('haiku')) return 'haiku';
      if (m.includes('astra')) return 'astra';
      if (m.includes('sol')) return 'sol';
      if (m.includes('terra')) return 'terra';
      if (m.includes('luna')) return 'luna';
      if (m.includes('carbon')) return 'carbon';
      if (m.includes('hydrogen')) return 'hydrogen';
      if (m.includes('argon')) return 'argon';
      if (m.includes('neon')) return 'neon';
      if (m.includes('v4-pro')) return 'v4-pro';
      if (m.includes('flash')) return 'flash';
      return model.length > 14 ? model.slice(0, 14) : model;
    };
    for (const member of team.members) {
      const profile = snapshot.members.find(m => m.id === member.id);
      const info = snapshot.providers.find(p => p.id === member.executor);
      const isSpeaking = state.active && state.speaking === member.id;
      let model: string | undefined;
      let effort: string | undefined;
      if (isSpeaking) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.author === member.id && msg.runId) {
            const run = snapshot.runs.find(r => r.id === msg.runId);
            const cfg = run?.effectiveConfig ?? run?.requestedConfig;
            if (cfg?.model) { model = cfg.model; effort = cfg.effort; break; }
          }
        }
      }
      if (!model) {
        const baseCfg = {
          model: profile?.model || snapshot.settings.models?.[member.executor] || info?.model,
          effort: profile?.effort || snapshot.settings.efforts?.[member.executor],
          modelSource: 'default' as const,
          effortSource: 'default' as const,
          capturedAt: '',
        };
        const routed = applyCostModeToConfig(baseCfg, {
          executor: member.executor,
          costMode: profile?.costMode,
          economyModel: profile?.economyModel,
          engineeringModel: profile?.engineeringModel,
        }, tier);
        model = routed.model;
        effort = routed.effort;
      }
      if (model) {
        const modeTag = costLabels[profile?.costMode ?? 'normal'] ?? '全勤';
        map[member.id] = {
          short: shorten(model),
          full: `${modeTag} · ${model}${effort ? ` · ${effort}` : ''}`,
        };
      }
    }
    return map;
  }, [team.members, snapshot.members, snapshot.providers, snapshot.settings.models, snapshot.settings.efforts, snapshot.runs, messages, state.active, state.speaking, discussion?.phase, discussion?.style, mode]);
  const showStage = stageOn && Boolean(spotlight);
  return <Root className={`room ${project ? 'room-embedded' : ''} ${personal ? 'personal-room' : ''} ${showStage ? 'has-stage' : ''}`} aria-label={personal?personal.kind==='desk'?'工位聊天':'汇报对话':project ? '会议聊天' : undefined} {...attach.dropTarget}>
    {(!project && (!personal || personal.kind === 'desk')) && <RoomBackdrop />}
    <div className="room-top">
    {project ? surface?.recordActions ? null : <div className="room-tool-row">
      <div className="room-tool-left" style={{ flex: '1 1 auto', minWidth: 0, marginRight: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        {(surface?.title || surface?.hint) && <span className="room-tool-title">{surface?.title??''}{surface?.hint&&<small>{surface.hint}</small>}</span>}
        {thread?.summary && <div className="topic-bar-summary" style={{ flex: '1 1 auto', minWidth: 0 }}><SummaryNote thread={thread} /></div>}
      </div>
      <button type="button" className={`button small secondary ${stageOn ? 'pressed' : ''}`} aria-pressed={stageOn} title={stageOn ? '收起角色立绘' : '显示角色立绘'} onClick={toggleStage}><Sparkles size={13} />立绘</button>
      <button type="button" className="icon-button topic-more" aria-label="会议记录操作" aria-haspopup="menu" title="压缩、导出和清空会议记录" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 6, items: recordItems }); }}><MoreHorizontal size={16} /></button>
    </div> : <>
    <header className="room-head">
      <span className="room-icon"><MessagesSquare size={20} /></span>
      <div className="room-title"><h1>{personal?.title??'茶歇室'}</h1><p title={personal?.hint}>{personal?.hint??'闲聊时自由接话，开会时轮流发言，随时都可以插话。'}</p></div>
      <div className="room-actions">
        {personal?.headerActions}
        <button type="button" className={`button small secondary ${stageOn ? 'pressed' : ''}`} aria-pressed={stageOn} title={stageOn ? '收起角色立绘' : '显示角色立绘'} onClick={toggleStage}><Sparkles size={14} />{stageOn ? '隐藏立绘' : '显示立绘'}</button>
        {split && <button type="button" className={`button small secondary ${split.active ? 'pressed' : ''}`} aria-pressed={split.active} title={split.active ? '回到单独的聊天室' : '聊天室和当前项目会话左右并排'} onClick={split.toggle}><Columns2 size={14} />{split.active ? '取消并排' : '并排显示'}</button>}
        {personal?.kind==='report'&&<button type="button" className="icon-button" title="导出完整话题" aria-label="导出当前话题" disabled={busy || state.active || !messages.length || !snapshot.backendReady} onClick={() => void exportTopic()}><Download size={16} /></button>}
      </div>
    </header>
    {personal?.kind==='report'&&personal.subbar&&<div className="room-topic-bar">{personal.subbar}</div>}
    {personal?.kind!=='report'&&<div className="room-topic-bar"><label className="topic-picker"><span>话题</span><select aria-label="话题记录" value={selectedId} disabled={busy||noTopic||Boolean(personal&&state.active)} onChange={event => void selectTopic(event.target.value)}>{noTopic&&<option value="">当前文件夹暂无话题</option>}{threads.map(item => <option key={item.id} value={item.id}>{item.archivedAt ? '归档 · ' : '当前 · '}{item.title}</option>)}</select></label>
      {archived ? <span className="topic-archived">归档记录 · 只读 <button type="button" className="link-button" onClick={() => setArchiveId(undefined)}>回到当前话题</button><button type="button" className="link-button" disabled={busy || state.active || Boolean(compressing)} onClick={() => thread && setNewTopic({ from: thread })}><FileStack size={12} />接着聊</button></span>
        : <button type="button" className="button small secondary" disabled={busy || state.active || Boolean(compressing) || (!personal&&!messages.length) || !snapshot.backendReady} onClick={() => setNewTopic({})}><MessageSquarePlus size={14} />开新话题</button>}
      <button type="button" className={`icon-button topic-more ${panel ? 'pressed' : ''}`} aria-label="话题操作" aria-haspopup="menu" title="话题管理、压缩、导出和清空" onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom + 6, items: [
        { label: panel ? '收起话题管理' : '话题管理', icon: <Layers size={14} />, onSelect: () => setPanel(value => !value) },
        ...(!archived && messages.length > 0 ? [{ label: '压缩上下文', icon: <Sparkles size={14} />, disabled: busy || state.active || Boolean(compressing) || !summarizer.member || !snapshot.backendReady || historyOnly, onSelect: () => void compressCurrent() }] : []),
        ...(!archived && !historyOnly && autoCompressAvailable ? [{ label: autoCompressLabel, icon: <Sparkles size={14} />, disabled: !snapshot.backendReady, onSelect: openAutoCompress }] : []),
        { label: personal ? '导出当前话题' : '导出聊天室', icon: <Download size={14} />, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void exportTopic() },
        'separator' as const,
        archived ? { label: '删除归档话题', icon: <Trash2 size={14} />, danger: true, disabled: busy || state.active, onSelect: () => void manage('delete') }
          : { label: '清空当前话题', icon: <Eraser size={14} />, danger: true, disabled: busy || state.active || !messages.length || !snapshot.backendReady, onSelect: () => void manage('clear') },
      ] }); }}><MoreHorizontal size={16} /></button>
      {thread && (thread.summary || thread.inherited) && <div className="topic-bar-summary"><SummaryNote thread={thread} /><span className="topic-bar-links">{thread.summary?.proposals?.length ? <button type="button" className="link-button topic-memory" onClick={() => setProposing(true)}><BookmarkPlus size={12} />有 {thread.summary.proposals.length} 条可以记住的事</button> : null}{thread.inherited && !archived && <button type="button" className="link-button topic-uninherit" disabled={busy || state.active || Boolean(compressing) || !snapshot.backendReady} title="当前话题不再带着之前话题的摘要" onClick={() => void uninherit()}><Unlink size={12} />不再延续</button>}{global&&thread.summary && <button type="button" className="link-button topic-handoff" onClick={() => setHandoff({ threadId: thread.id, text: `请根据团队聊天室话题「${thread.title}」的讨论摘要完成任务。\n\n${thread.summary!.text}` })}><Briefcase size={12} />把摘要交给项目</button>}</span></div>}
    </div>}</>}
    {project && surface?.recordActions && thread?.summary && <div className="room-topic-bar"><div className="topic-bar-summary"><SummaryNote thread={thread} /></div></div>}
    {!archived && !personal && !surface?.readOnly && <RoomPresence discussion={discussion} state={state} invited={invited} ready={member => ready(member.executor)}
      locked={state.active} busy={busy || Boolean(compressing) || !snapshot.backendReady} modelLabels={presenceModels} onToggle={toggle}
      showNextStep={!surface} flowNextStep={Boolean(project?.flowNextStep)} onConfigure={project?.onConfigureMember}
      onRest={relayEnabled ? (memberId,resting)=>void invoke('room.member.rest',{memberId,resting}).catch(()=>{}) : undefined}
      onAnswer={openAnswer}
      onHost={id=>void chooseHand('member',id)} onMention={member => quickMention(member.name)}
      onPause={() => void invoke('room.pause').catch(() => {})} onResume={() => void resumeDiscussion()} onEnd={() => void endDiscussion()} />}
    </div>
    <div className="room-stage-layout">
    <div className="room-stage-main">
    <div className="room-messages-wrap">
    <div className="room-messages" role="log" aria-label={surface?'圆桌消息':personal?personal.kind==='desk'?'个人工位消息':'个人汇报消息':project?'项目会议室消息':'茶歇室消息'} ref={list} onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (pinned.current && !archived) { if (unseen) setUnseen(0); markSeen();acknowledge(); } if (node.scrollTop < 40 && hasMore && !loadingRef.current) void loadHistory(true); }}>
      {hasMore && <button type="button" className="button small quiet room-load-more" disabled={loading} onClick={() => void loadHistory(true)}>{loading ? '正在加载…' : '加载更早的消息'}</button>}
      {loading && !messages.length && <div className="room-system">正在加载历史…</div>}
      {!messages.length && !archived && project?.empty}
      {!messages.length && !archived && personal?.empty}
      {!messages.length && !archived && !project && !personal && <div className="room-empty">
        <div className="room-empty-team">{team.members.map(member => <button key={member.id} type="button" className="room-avatar-mention" title={`点击 @${member.name}`} aria-label={`@${member.name}`} onClick={() => quickMention(member.name)}><Avatar member={member} size={56} /></button>)}</div>
        <h2>大家都在，聊点什么？</h2><p>成员只会说话，不会执行命令或修改文件。</p>
        <div className="room-suggestions">{SUGGESTIONS.map(text => <button type="button" key={text} disabled={busy || state.active} onClick={() => { if (text.startsWith('开个会')) { setMode('meeting'); setDraft(text.replace(/^开个会：/, '')); textarea.current?.focus(); } else void send(text); }}>{text}</button>)}</div>
      </div>}
      {messages.map((message, index) => <Fragment key={message.id}>{index === dividerIndex && <div className="room-new-divider" role="separator"><span>以下是新消息</span></div>}{(() => {
        if (message.contextOnly) return null;
        if (message.system || message.author === 'system') return message.link ? <RoomNote key={message.id} message={message} snapshot={snapshot} invoke={invoke} archived={archived} onOpen={(projectId, sessionId) => onOpenSession?.(projectId, sessionId)} /> : <div key={message.id} className="room-system" data-message-id={message.id}>{message.text}</div>;
        if (message.discussionControl) return null;
        const streamed = live.get(message.id) ?? '';
        const activity = message.status === 'speaking' ? liveActivity.get(message.id) : undefined;
        const text = message.status === 'speaking' ? message.discussionId ? streamed : isRoomPass(streamed) || roomMarkerPending(streamed) || roomReaction(streamed) ? '' : streamed || message.text : message.author==='user'?message.text:readableContent(message.text);
        const card = surface?.renderMessage?.(message,text)??personal?.renderMessage?.(message)??(project?.renderFlow && (message.flowPlan || message.flowDecision || message.flowReport || message.jointReview || message.roundtable) ? project.renderFlow(message) : undefined);
        if (card) return <div key={message.id} className={`room-line flow-line member-${message.author}${enter(message)}`} data-message-id={message.id}>{message.author === 'user' ? <UserAvatar name={name(message)} avatar={profile.avatar} size={30} /> : (!archived && !personal ? <button type="button" className="room-avatar-mention" title={`点击 @${name(message)}`} aria-label={`@${name(message)}`} onClick={() => quickMention(name(message))}><Avatar member={team.get(message.author)} id={message.author} size={30} /></button> : <Avatar member={team.get(message.author)} id={message.author} size={30} />)}<div className="flow-line-body"><span className="room-meta"><strong>{name(message)}</strong><time>{time(message.at)}</time></span><ErrorBoundary area="汇报消息" compact>{card}</ErrorBoundary></div></div>;
        // A reaction-only turn shows on the message it answered, not as a line of its own.
        if (message.status === 'passed' && message.reaction) return null;
        if (message.status === 'passed') return <details key={message.id} className="room-passed" data-message-id={message.id}><summary>{name(message)} 选择不发言 <time>{time(message.at)}</time></summary><p>这次没有需要补充的内容。判断是否发言仍会使用额度。</p></details>;
        if (message.author === 'user') {
          const quoteId = message.replyTo ?? message.inReplyTo;
          const quoted = quoteId ? messages.find(m => m.id === quoteId) : undefined;
          return <div key={message.id} className={`room-line mine${enter(message)}`} data-message-id={message.id}>
            <div className="room-bubble-wrap">
              <span className="room-meta"><time>{time(message.at)}</time><strong>{name(message)}</strong></span>
              {message.ownerInterruption && <small className="room-interruption-target">打断提问 · @{message.ownerInterruption.memberName || '全体'}</small>}
              {quoteId && <div className="room-user-quote">{message.ownerInterruption?'引用':'回复'} {quoted ? `${name(quoted)}：${quoted.text.replace(/\s+/g, ' ').slice(0, 72)}${quoted.text.length > 72 ? '…' : ''}` : '较早消息'}</div>}
              <div className="room-bubble" onContextMenu={event => openMessageMenu(event, messageMenu(message, false))}>{message.text}</div>
              <AttachmentList items={message.attachments} invoke={invoke} align="end" />
              <div className="room-message-actions">
                <Reactions message={message} name={authorName} userAvatar={profile.avatar} />
                <span className="room-tools">{!historyOnly && !archived && !personal && snapshot.backendReady && <button type="button" className="link-button room-reply-button" aria-label="撤回并重新编辑" onClick={() => void recallMessage(message, true)}>撤回并编辑</button>}{moreButton(message, false)}</span>
              </div>
              {personal?.messageActions?.(message,messages)}
            </div>
            <UserAvatar name={name(message)} avatar={profile.avatar} size={36} />
          </div>;
        }
        const member = team.get(message.author);
        const reactable = !archived && snapshot.backendReady && ['done', 'failed', 'stopped'].includes(message.status ?? 'done');
        const long = message.status !== 'speaking' && isLong(text), folded = long && !expanded.has(message.id);
        const canReply = !archived && message.status === 'done';
        const run = message.runId ? snapshot.runs.find(item => item.id === message.runId) : undefined;
        const unknown = run?.status === 'unknown' && message.status !== 'speaking';
        const modelLabel = run?.effectiveConfig?.modelStatus === 'reported' ? run.effectiveConfig.model : run?.requestedConfig?.model;
        const effortLabel = run?.effectiveConfig?.effortStatus === 'reported' ? run.effectiveConfig.effort : run?.requestedConfig?.effort;
        const actual = [modelLabel, effortLabel].filter(Boolean).join(' · ');
        const silent = message.error ?? (unknown ? '成员程序结束了这一轮，但没有返回内容，结果待核对。可能是登录失效或连接中断，可在“设置与连接”检查这位成员。工作台不会自动重发。' : run?.error ?? '（没有说话）');
        return <div key={message.id} className={`room-line member-${member?.id ?? 'claude'}${enter(message)}`} data-message-id={message.id}>
          {member ? (!archived && !personal ? <button type="button" className="room-avatar-mention" title={`点击 @${member.name}`} aria-label={`@${member.name}`} onClick={() => quickMention(member.name)}><Avatar member={member} size={36} mood={message.status === 'speaking' ? 'working' : undefined} /></button> : <Avatar member={member} size={36} mood={message.status === 'speaking' ? 'working' : undefined} />) : <span className="room-retired-avatar" aria-hidden="true">{[...name(message)][0]}</span>}
          <div className="room-bubble-wrap"><span className="room-meta"><strong>{name(message)}</strong><time title={run ? effectiveConfigText(run.requestedConfig, run.effectiveConfig) : undefined}>{time(message.at)}</time>{actual && <span className="room-model" title={run ? effectiveConfigText(run.requestedConfig, run.effectiveConfig) : '这一轮使用的模型与思考程度'}>{actual}</span>}{message.inReplyTo && <span className="room-reply-to">回复 {messages.find(m => m.id === message.inReplyTo)?.authorName ?? '较早的消息'}</span>}{message.kind === 'summary' && <em>会议总结</em>}{message.status === 'failed' && <em className="room-failed">{unknown ? '结果待核对' : run?.delivery==='prepared' ? '未发送' : '回复失败'}</em>}{message.status === 'stopped' && <em>已停止</em>}</span>
            <div className={`room-bubble ${message.status === 'speaking' && !text ? 'thinking' : ''} ${folded ? 'folded' : ''}`} onContextMenu={message.status === 'speaking' ? undefined : event => openMessageMenu(event, messageMenu(message, canReply))}>{text ? <Markdown text={text} onDocument={onDocument} /> : message.status === 'speaking' ? (() => {
              const totalSec = elapsedSec(run?.createdAt ?? message.at);
              const idleSec = activity?.lastEventAt ? elapsedSec(activity.lastEventAt) : totalSec;
              const tone = activity?.waitingApproval ? 'warn' : idleSec >= 90 ? 'stale' : activity?.lastEventAt && idleSec < 15 ? 'active' : 'wait';
              const heartbeat = activity?.waitingApproval ? '请查看「待你处理」' : activity?.lastEventAt ? (idleSec < 5 ? '刚刚有动态' : `${formatSeconds(idleSec)} 前有动态`) : (idleSec >= 90 ? `已静默 ${formatSeconds(idleSec)}，可能较慢或卡住` : '等待首包…');
              const donePlan = activity?.plan.filter(s => s.status === 'completed').length ?? 0;
              return <div className={`room-thinking tone-${tone}`} aria-live="polite">
                <div className="room-thinking-head">
                  <span className={`room-thinking-dot tone-${tone}`} aria-hidden="true" />
                  <span className="room-thinking-phase">{activity?.phaseLabel ?? '思考中'}</span>
                  <span className="room-thinking-elapsed">{formatSeconds(totalSec)}</span>
                  {activity?.plan.length ? <span className="room-plan-count">{donePlan}/{activity.plan.length}</span> : null}
                  <span className="room-thinking-heartbeat">{heartbeat}</span>
                </div>
                {activity?.plan.length ? <ul className="room-plan-list">{activity.plan.map((step, i) => <li key={i} className={`room-plan-item is-${step.status}`}><span className="room-plan-mark" aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : '○'}</span><span>{step.text}</span></li>)}</ul> : null}
                {!activity?.plan.length && activity?.steps.length ? <ul className="room-plan-list room-step-timeline">{activity.steps.map((step, i) => {
                  const isCurrent = i === activity.steps.length - 1;
                  return <li key={i} className={`room-plan-item ${isCurrent ? 'is-in_progress' : 'is-completed'}`}><span className="room-plan-mark" aria-hidden="true">{isCurrent ? '●' : '✓'}</span><span>{step}</span></li>;
                })}</ul> : null}
                {activity?.reasoning ? <div className="room-thinking-body">{activity.reasoning}</div> : null}
              </div>;
            })() : <span className="room-silent">{silent}</span>}</div>
            {long && <button type="button" className="link-button room-fold-button" aria-expanded={!folded} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}>{folded ? '展开全文' : '收起'}</button>}
            {message.imageGeneration&&message.status==='speaking'&&!message.generatedImages?.length&&<small className="room-reply-note">正在生成图片，可以随时停止。</small>}
            <GeneratedImages images={message.generatedImages} invoke={invoke} onEdit={!archived&&!state.active&&canGenerateImage?image=>setImageDialog({text:draft,draftVersion:composer.version,attachments:[image]}):undefined}/>
            {message.status === 'failed' && message.error && text && <small className="room-error">{message.error}</small>}
            <div className="room-message-actions">
              <Reactions message={message} name={authorName} userAvatar={profile.avatar} onToggle={reactable ? emoji => void react(message, emoji) : undefined} />
              {message.status !== 'speaking' && <span className="room-tools">{canReply && <button type="button" className="link-button room-reply-button" aria-label={`回复 ${name(message)} 的消息`} onClick={() => replyToMessage(message)}>回复这条</button>}{moreButton(message, canReply)}</span>}
            </div>
            {personal?.messageActions?.(message,messages)}
          </div>
        </div>;
      })()}</Fragment>)}
      {compressing && <div className="room-system room-compressing-pill" role="status"><span className="room-thinking-dot tone-active" aria-hidden="true" /><span>{state.compressingAuto ? `管理员（${compressing.name}）正在自动压缩上下文…` : `管理员（${compressing.name}）正在压缩上下文…`}</span></div>}
      {personal?.dock}{archived && surface?.dock}
    </div>
    <MessageScrollRail listRef={list} messages={messages} team={team} name={name} />
    </div>
    {unseen > 0 && <button type="button" className="room-jump" onClick={jumpToLatest}><ArrowDown size={14} />有 {unseen} 条新消息</button>}
    {!archived && (() => { const roomHint = personal ? '' : compressing && !state.active ? (state.compressingAuto ? `管理员（${compressing.name}）正在自动压缩上下文…` : `管理员（${compressing.name}）正在压缩上下文…`) : discussion?.phase==='awaiting-host' ? '等你点名' : state.active ? typingInChat ? '你正在输入，AI 已等你发完再接话…' : speaking ? `${speaking.name} 正在说话…` : paceMs > 0 && mode === 'chat' ? `阅读缓冲中（${paceMs / 1000}s），随时可插话…` : '正在安排发言…' : candidates.length ? '选择要点名的成员' : named.unknown.length ? `未识别点名：${named.unknown.join('、')}` : named.ids.length ? mode==='meeting'?'只请被 @ 的成员回答，之后等你继续':`优先请 ${participants.map(member => member.name).join('、')} 接话，其他在场成员仍可参与` : usable.length ? mode === 'chat' ? '大家自由接话；输入时 AI 会自动让行，不怕插不上嘴' : handRaise ? '每轮轮流发言后先举手，想补充的再发言' : '每人回答一次后等你，点击整理会议纪要结束' : '先邀请至少一位已准备好的成员'; return <div className="room-composer">
      {(project?.dock ?? surface?.dock) && <div className="room-dock-anchor">{project?.dock ?? surface?.dock}</div>}
      {replyTo && (() => { const target = messages.find(m => m.id === replyTo); return <div className="room-reply-note">回复 {target ? `${name(target)}：${target.text.replace(/\s+/g, ' ').slice(0, 80)}` : '较早消息'} <button type="button" className="link-button" onClick={() => setReplyTo(undefined)}>取消回复</button></div>; })()}
      {pendingFollowUps.length > 0 && <div className="room-midturn-queue" role="region" aria-label="待发送队列">
        {pendingFollowUps.map(item => {
          const target = team.get(item.memberId);
          return <div className="room-midturn-item" key={item.id}>
            <span className="room-midturn-badge">排队发给 {target?.name ?? '成员'}</span>
            <span className="room-midturn-text" title={item.text}>{item.text.replace(/\s+/g, ' ')}</span>
            <button type="button" className="button small secondary room-midturn-btn" disabled={sending || busy || !snapshot.backendReady} onClick={() => void promoteFollowUp(item.id)} title="不等 TA 说完，立刻插队发给 TA 处理">立即发送</button>
            <button type="button" className="button small quiet room-midturn-cancel" disabled={sending || busy || !snapshot.backendReady} onClick={() => void cancelFollowUp(item.id)} aria-label="取消排队">×</button>
          </div>;
        })}
      </div>}
      <div className={`composer room-input ${attach.dragging ? 'dragging' : ''}`}>
        {attach.dragging && <div className="drop-hint">松开即可附上文件</div>}
        <AttachmentTray items={attach.items} onRemove={attach.remove} />
        {composer.error&&<p role="status" className="composer-draft-error">{composer.error} <button type="button" className="link-button" onClick={composer.retry}>重试保存草稿</button></p>}
        {discussion?.handRound&&(discussion.phase==='awaiting-host'||discussion.phase==='raising'&&discussion.hostPick&&discussion.handRound.status==='collecting')&&<section className="room-host-choice" aria-label="举手点名">
          <p>{discussion.phase==='raising'?`正在收集举手（${Object.values(discussion.handRound.ballots).filter(b=>!['pending','running'].includes(b.status)).length}/${Object.keys(discussion.handRound.ballots).length} 已完成）。已举手的成员可先点名，未完成的举手会撤回。`:'举手已收集，请选谁接着说。'}</p>
          {Object.entries(discussion.handRound.ballots).some(([,b])=>b.status==='failed'||b.status==='invalid')&&<p className="panel-muted">{Object.entries(discussion.handRound.ballots).filter(([,b])=>b.status==='failed'||b.status==='invalid').map(([id])=>team.get(id)?.name??'成员').join('、')} 的举手未完成，可查看活动记录。</p>}
          <div className="room-host-actions">{discussion.members.filter(id=>discussion.handRound!.ballots[id]?.status==='done'&&(discussion.handRound!.ballots[id].want??0)>0).map(id=><button type="button" className="button small secondary" key={id} disabled={busy||!snapshot.backendReady||!ready(team.get(id)?.executor??'')} onClick={()=>void chooseHand('member',id)}>请 {team.get(id)?.name??'成员'} 发言 · {discussion.handRound!.ballots[id].want}/3</button>)}<button type="button" className="button small quiet" disabled={busy||!snapshot.backendReady||!Object.values(discussion.handRound.ballots).some(b=>b.status==='done'&&(b.want??0)>0)} onClick={()=>void chooseHand('auto')}>按举手自动选</button><button type="button" className="button small quiet" disabled={busy||!snapshot.backendReady} onClick={()=>void chooseHand('skip')}>都不用补充，下一轮</button></div>
        </section>}
        {!relayDraft&&mentionedWorker&&project?.onTaskRequest&&<label className="room-work-intent">@{mentionedWorker.name}<select aria-label="点名用途" value={workIntent} onChange={e=>setWorkIntent(e.target.value as typeof workIntent)}><option value="ask">只是问问</option><option value="add">安排新任务</option><option value="supplement">补充到 TA 当前的任务</option></select></label>}
        {candidates.length > 0 && <div className="room-mentions" role="listbox" id="room-mentions" aria-label="点名成员">{candidates.map((member, index) => <button type="button" role="option" id={`room-mention-${index}`} key={member.id} aria-selected={index === mentionIndex % candidates.length} className={index === mentionIndex % candidates.length ? 'selected' : ''} onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(member)}><Avatar member={member} size={24} ring={false} /><span>@{member.name}</span></button>)}</div>}
        <textarea ref={textarea} value={draft} onPaste={attach.onPaste} aria-label={personal?personal.kind==='desk'?'在工位里说话':'在汇报里说话':project ? '在会议室里说话' : '在聊天室里说话'} aria-autocomplete="list" aria-controls={candidates.length ? 'room-mentions' : undefined} aria-activedescendant={candidates.length ? `room-mention-${mentionIndex % candidates.length}` : undefined} placeholder={midTurnMode && activeSpeaker ? `${activeSpeaker.name} 正在输出… Enter 排队等 TA 说完再发，Ctrl+Enter 立即发给 TA 处理` : personal?'写下问题或要求… Enter 发送，Shift + Enter 换行':mode === 'meeting' ? '写下会议议题或随时补充… Enter 发送，Shift + Enter 换行，@ 谁就只请谁回答' : '说点什么… Enter 发送，Shift + Enter 换行，@ 可指定优先接话者'} onChange={event => { const next = event.target.value; if (replyTo && draft.length > 0 && next.length === 0) setReplyTo(undefined); setDraft(next); if(!personal)updateMention(next, event.target.selectionStart); }} onClick={event => {if(!personal)updateMention(event.currentTarget.value, event.currentTarget.selectionStart);}} onKeyDown={event => {
          if (candidates.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setMentionIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); }
          else if (candidates.length && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); chooseMention(candidates[mentionIndex % candidates.length]); }
          else if (midTurnMode && event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMidTurn('immediate'); }
          else if (isSendKey(event)) { event.preventDefault(); void send(); }
          else if (event.key === 'Backspace' && replyTo && !draft) { setReplyTo(undefined); }
          else if (event.key === 'Escape') { if (candidates.length) setMention(null); else if (replyTo) setReplyTo(undefined); }
        }} disabled={!snapshot.backendReady || busy || historyOnly || personalLoading || noTopic || !composer.ready} />
        {historyOnly&&<p className="panel-muted" role="status">{surface?.readOnly?surface.hint:personal?.kind==='report'?'原成员已删除，汇报事实保留。':'这份话题只供阅读；继续工作请新开话题。'}</p>}<div className="composer-bottom">{!personal&&!historyOnly&&canInterrupt&&<button type="button" className="button small quiet" disabled={!snapshot.backendReady} onClick={()=>openInterruption()}>打断提问</button>}<AttachButton onPick={() => void attach.pick()} busy={attach.busy} disabled={!snapshot.backendReady||!composer.ready||historyOnly} />{!project && !personal && <button type="button" className="composer-tool" aria-label="生成图片" disabled={!canGenerateImage||state.active||busy||sending||Boolean(compressing)||!snapshot.backendReady} title={state.active?'生成图片：先暂停讨论并等待当前发言结束':canGenerateImage?'生成图片：让 ChatGPT 生成或修改一张图片':'生成图片：需要连接支持绘图的 ChatGPT，并允许联网'} onClick={()=>setImageDialog({text:draft,draftVersion:composer.version,attachments:attach.items})}><ImagePlus size={16}/></button>}{personal?.composerControls?.(room)}{!personal&&<div className="composer-mode"><div className="segmented" role="radiogroup" aria-label="聊天方式"><button type="button" role="radio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'selected' : ''} disabled={state.active} onClick={() => setMode('chat')} title="大家自由接话，不限次数；聊到自然告一段落、大家都同意时会收尾">闲聊</button><button type="button" role="radio" aria-checked={mode === 'meeting'} className={mode === 'meeting' ? 'selected' : ''} disabled={state.active} onClick={() => setMode('meeting')} title="每人回答一次后等你；由你点击整理会议纪要结束">开会</button></div>{mode === 'chat' && <div className="segmented" role="radiogroup" aria-label="闲聊节奏" title="每条 AI 发言后的阅读缓冲时间；你在打字时会自动等你发完"><button type="button" role="radio" aria-checked={paceMs === 0} className={paceMs === 0 ? 'selected' : ''} onClick={() => choosePace(0)}>快</button><button type="button" role="radio" aria-checked={paceMs === 6000} className={paceMs === 6000 ? 'selected' : ''} onClick={() => choosePace(6000)}>适中 6s</button><button type="button" role="radio" aria-checked={paceMs === 12000} className={paceMs === 12000 ? 'selected' : ''} onClick={() => choosePace(12000)}>慢 12s</button></div>}{mode === 'meeting' && <><label className="room-hand-option" title="一轮回答后举手，每人最多补充一次，没人举手后等你。单人会议不需要举手。举手也计入调用次数。"><input type="checkbox" checked={handRaise&&participants.length>1} disabled={participants.length<2||state.active||discussion?.phase==='awaiting-host'} onChange={e => {setHandRaise(e.target.checked);if(e.target.checked)setHostPick(!project);}} />{project?'AI 自行补充':'举手模式'}</label>{handRaise&&<label className="room-hand-option"><input type="checkbox" checked={hostPick} disabled={state.active||discussion?.phase==='awaiting-host'} onChange={e=>setHostPick(e.target.checked)}/>举手后由我点名</label>}</>}</div>}<span className="composer-hint" title={relayEnabled ? '跨项目：@项目/成员 问题；@成员 切到 项目；/back 返回' : personal ? undefined : roomHint}>{personal?personal.kind==='desk'?personalSession?.restoredHistoryOnly?'只读历史':personalSession&&!personalSession.writeMode?'只读查看当前文件夹':personalSession?.workspaceKind==='original'?'直接读写当前文件夹':'在任务副本中工作，应用后写回原文件夹':'只读回答；改要求请通过任务按钮确认':roomHint}{composer.hasDraft?' · 草稿已保留':''}</span>{!personal&&(discussion&&discussion.phase!=='idle'?discussion.style!=='chat':mode==='meeting')&&<button type="button" className={`button small ${discussion?.phase==='waiting_user'&&!discussion.questions.some(q=>q.to==='user'&&pendingDiscussionQuestion(q))?'primary':'secondary'} composer-minutes`} aria-label="整理会议纪要" disabled={!snapshot.backendReady||stopping||minutesBusy||historyOnly||Boolean(ownerQuestions.length||discussion?.interruption)||!hasMeetingRemarks(discussion,messages)||discussion?.phase==='summarizing'||!minutesMembers.length} onClick={()=>void openMinutes()}><FileStack size={15}/>整理会议纪要</button>}{(stopping||surface?.active||state.active||compressing||state.generatingImage||discussion&&['talking','raising','awaiting-host','closing','summarizing'].includes(discussion.phase))&&<button type="button" className="button small stop-button" aria-label="中止当前对话" disabled={!snapshot.backendReady||stopping} onClick={()=>{setStopping(true);void invoke('room.stop').catch(()=>{}).finally(()=>setStopping(false));}}><StopCircle size={15}/>中止</button>}{midTurnMode && activeSpeaker && <button type="button" className="button small secondary room-midturn-immediate" disabled={(!draft.trim() && !attach.items.length) || sending || busy || !snapshot.backendReady || !composer.ready} onClick={() => void sendMidTurn('immediate')} title={`不等待输出结束，立刻插队/联同当前内容发给 ${activeSpeaker.name} 处理（Ctrl+Enter）`}>立即发给 {activeSpeaker.name}</button>}<button type="button" className="send-button room-send" aria-label={midTurnMode && activeSpeaker ? `排队等 ${activeSpeaker.name} 说完再发` : personal?personal.kind==='desk'?'发送到工位':'发送到汇报':mode === 'meeting' && !(discussion && discussion.phase !== 'idle') ? '开始会议' : '发送到聊天室'} title={midTurnMode && activeSpeaker ? `等 ${activeSpeaker.name} 说完后自动一对一发送（Enter）` : undefined} disabled={(!draft.trim() && !attach.items.length) || sending || busy || Boolean(ownerQuestions.length||discussion?.interruption) || (!midTurnMode && state.active && state.mode !== 'discuss') || Boolean(compressing) || (!midTurnMode && !usable.length && !discussion && !relayDraft)  || !snapshot.backendReady || historyOnly || personalLoading || noTopic || !composer.ready} onClick={() => void send()}>{sending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}</button></div>
      </div>
    </div>; })()}
    </div>
    {showStage && spotlight && <aside className={`room-portrait-stage member-${spotlight.id} ${speaking?.id === spotlight.id ? 'speaking' : ''}`} aria-label="角色立绘">
      <div className="room-stage-card">
        <div className="room-stage-art-wrap">
          <Portrait member={spotlight} className="room-stage-portrait" />
        </div>
        <div className="room-stage-meta">
          <div className="room-stage-title">
            <strong>{spotlight.name}</strong>
            <span className={`room-stage-badge ${speaking?.id === spotlight.id ? 'live' : ''}`}>{speaking?.id === spotlight.id ? '正在发言' : ready(spotlight.executor) ? '在场待命' : '离线'}</span>
          </div>
          <small>{spotlight.product}</small>
          {spotlight.motto && <p className="room-stage-motto">「{spotlight.motto}」</p>}
        </div>
      </div>
      {stageCast.length > 1 && <div className="room-stage-cast" role="tablist" aria-label="切换查看立绘">
        {stageCast.map(member => {
          const active = member.id === spotlight.id;
          const talking = speaking?.id === member.id;
          return <button type="button" role="tab" aria-selected={active} key={member.id} className={`room-cast-chip member-${member.id} ${active ? 'active' : ''} ${talking ? 'speaking' : ''}`} onClick={() => setFocusedMemberId(member.id)} title={`查看 ${member.name} 立绘`}>
            <Avatar member={member} size={22} ring={false} mood={talking ? 'working' : undefined} />
            <span>{member.name}</span>
          </button>;
        })}
      </div>}
    </aside>}
    </div>
    {panel && <TopicPanel onChanged={() => setReloads(n => n + 1)} snapshot={personal?{...snapshot,room}:snapshot} personal={Boolean(personal)} historyOnly={historyOnly} selectedId={selectedId} usable={writers} invoke={invoke} busy={busy}
      onSelect={id => { void selectTopic(id); setPanel(false); }} onContinue={item => personal?void selectTopic(item.id):setNewTopic({ from: item })}
      onExport={id => void exportTopic(id)} onClear={() => void manage('clear')} onClose={() => setPanel(false)} />}
    {questionDialog&&questionDialog.discussionId===discussion?.id&&!archived&&(() => {
      const activeQuestion = questionDialog.questionId ? ownerQuestions.find(item => item.id === questionDialog.questionId) : undefined;
      const asker = activeQuestion ? team.get(activeQuestion.from) : undefined;
      const sourceMessage = activeQuestion ? messages.find(m => m.id === activeQuestion.messageId) : undefined;
      const quickChoices = activeQuestion ? extractQuestionChoices(activeQuestion.text) : [];
      const activeIndex = activeQuestion ? ownerQuestions.findIndex(item => item.id === activeQuestion.id) : -1;
      const hasMoreQuestions = Boolean(activeQuestion && ownerQuestions.length > 1);
      const showContextToggle = Boolean(sourceMessage?.text && sourceMessage.text.trim() !== activeQuestion?.text.trim());
      return <Modal
        title={asker ? `回答 ${asker.name}` : questionDialog.questionId ? '回答成员' : '打断提问'}
        subtitle={hasMoreQuestions ? `当前有 ${ownerQuestions.length} 条待你确认的问题` : undefined}
        onClose={()=>{if(!questionBusy)setQuestionDialog(undefined);}}>
        <div className={`modal-body oq-modal ${asker ? `member-${asker.id}` : ''}`}>
          {questionDialog.questionId ? <>
            {hasMoreQuestions && <div className="oq-tabs" role="tablist" aria-label="切换待回答问题">
              {ownerQuestions.map((item, idx) => {
                const m = team.get(item.from);
                const selected = item.id === activeQuestion?.id;
                return <button type="button" role="tab" aria-selected={selected} key={item.id} className={`oq-tab ${m ? `member-${m.id}` : ''} ${selected ? 'active' : ''}`} disabled={questionBusy} onClick={() => { setQuestionContextOpen(false); setQuestionError(''); setQuestionDialog({ ...questionDialog, questionId: item.id, text: '' }); requestAnimationFrame(() => questionTextarea.current?.focus()); }}>
                  {m && <Avatar member={m} size={18} ring={false} />}
                  <span>{m?.name ?? '成员'}</span>
                  <span className="oq-tab-num">{idx + 1}/{ownerQuestions.length}</span>
                </button>;
              })}
            </div>}
            <div className={`oq-card ${asker ? `member-${asker.id}` : ''}`}>
              <div className="oq-card-head">
                {asker && <Avatar member={asker} size={30} ring={false} />}
                <div className="oq-card-meta">
                  <strong>{asker?.name ?? '成员提问'}</strong>
                  {asker?.product && <small>{asker.product}</small>}
                </div>
                {hasMoreQuestions && activeIndex >= 0 && <span className="oq-progress">{activeIndex + 1} / {ownerQuestions.length}</span>}
                {showContextToggle && <button type="button" className="link-button oq-ctx-toggle" onClick={() => setQuestionContextOpen(v => !v)}>{questionContextOpen ? '收起原发言' : '查看原发言'}</button>}
              </div>
              <p className="oq-question-text">{activeQuestion?.text ?? '这条问题已处理。'}</p>
              {questionContextOpen && sourceMessage && <div className="oq-context">
                <span className="oq-context-label">原发言上下文</span>
                <p>{sourceMessage.text.slice(0, 600)}{sourceMessage.text.length > 600 ? '…' : ''}</p>
              </div>}
            </div>
            {quickChoices.length > 0 && <div className="oq-choices" role="group" aria-label="快捷选项">
              <span className="oq-choices-label">快捷选择（点击填入，可再补充）</span>
              <div className="oq-choices-list">
                {quickChoices.map(choice => {
                  const chosen = questionDialog.text.trim() === choice;
                  return <button type="button" key={choice} className={`oq-choice ${chosen ? 'selected' : ''}`} disabled={questionBusy} onClick={() => { setQuestionDialog({ ...questionDialog, text: choice }); requestAnimationFrame(() => { const el = questionTextarea.current; if (el) { el.focus(); el.setSelectionRange(choice.length, choice.length); } }); }}>{choice}</button>;
                })}
              </div>
            </div>}
          </> : <>
            <label className="field">谁先回答<select value={questionDialog.memberId} disabled={questionBusy} onChange={e=>setQuestionDialog({...questionDialog,memberId:e.target.value})}><option value="">所有可用参会成员</option>{questionMembers.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
            <label className="field">引用发言<select value={questionDialog.quote?.id??''} disabled={questionBusy} onChange={event=>setQuestionDialog({...questionDialog,quote:quoteOptions.find(item=>item.id===event.target.value)})}>
              <option value="">不引用</option>
              {quoteOptions.map(item=><option value={item.id} key={item.id}>{name(item)}：{item.text.replace(/\s+/g,' ').slice(0,65)}</option>)}
            </select></label>
            {questionDialog.quote&&<div className="oq-card"><p className="oq-question-text">{name(questionDialog.quote)}：{questionDialog.quote.text.slice(0,350)}</p></div>}
          </>}
          <form id="owner-question-form" onSubmit={event=>{event.preventDefault();void submitQuestion();}}>
            <label className="field oq-field">
              <span>{questionDialog.questionId ? '你的回答' : '你的问题'}</span>
              <textarea ref={questionTextarea} className="oq-textarea" rows={4} autoFocus maxLength={12000} disabled={questionBusy} placeholder={questionDialog.questionId ? '写下你的决定或补充… Enter 提交，Shift + Enter 换行' : '写下你要打断提出的问题… Enter 发送，Shift + Enter 换行'} value={questionDialog.text} onChange={e=>setQuestionDialog({...questionDialog,text:e.target.value})} onKeyDown={event => { if (isSendKey(event)) { event.preventDefault(); void submitQuestion(); } }} />
            </label>
          </form>
          {questionError&&<p className="inline-notice error" role="alert">{questionError}</p>}
        </div>
        <div className={`modal-footer oq-footer ${asker ? `member-${asker.id}` : ''}`}>
          <span className="oq-shortcut-hint">Enter 提交 · Shift + Enter 换行</span>
          <div className="oq-footer-actions">
            <button type="button" className="button quiet" disabled={questionBusy} onClick={()=>setQuestionDialog(undefined)}>关闭</button>
            <button type="submit" form="owner-question-form" className="button primary oq-submit" disabled={questionBusy||!questionDialog.text.trim()}>{questionBusy ? '正在提交…' : questionDialog.questionId ? (hasMoreQuestions ? '提交并下一条' : '提交回答') : '发送并优先回答'}</button>
          </div>
        </div>
      </Modal>;
    })()}
    {autoCompressDialog&&<Modal title="自动压缩设置" subtitle="此设置用于茶歇室和项目会议室。" onClose={()=>{if(!savingAutoCompress)setAutoCompressDialog(undefined);}}>
      <div className="modal-body">
        <label><input type="checkbox" checked={autoCompressDialog.enabled} disabled={savingAutoCompress} onChange={event=>setAutoCompressDialog({...autoCompressDialog,enabled:event.target.checked})}/>自动压缩上下文</label>
        <label className="field">自动压缩管理员
          <select value={autoCompressDialog.memberId} disabled={savingAutoCompress} onChange={event=>setAutoCompressDialog({...autoCompressDialog,memberId:event.target.value})}>
            <option value="">自动选择</option>
            {autoCompressDialog.memberId&&!team.get(autoCompressDialog.memberId)&&<option value={autoCompressDialog.memberId}>原管理员已移除</option>}
            {team.members.map(member=><option key={member.id} value={member.id}>{member.name}{ready(member.executor)?'':'（暂不可用）'}</option>)}
          </select>
        </label>
        <p className="panel-muted">指定成员忙碌、休息或额度耗尽时，自动压缩会等待该成员可用。</p>
        {autoCompressError&&<p role="alert">{autoCompressError}</p>}
      </div>
      <div className="modal-footer"><button type="button" className="button quiet" disabled={savingAutoCompress} onClick={()=>setAutoCompressDialog(undefined)}>取消</button><button type="button" className="button primary" disabled={savingAutoCompress||Boolean(autoCompressDialog.memberId&&!team.get(autoCompressDialog.memberId))} onClick={()=>void saveAutoCompress()}>保存</button></div>
    </Modal>}
    {minutesDialog&&<Modal title="整理会议纪要" subtitle="依据目前已保存的发言整理结论、分歧和下一步；写完后结束本次会议。" onClose={()=>{if(!minutesBusy)setMinutesDialog(undefined);}}><div className="modal-body"><label className="field">整理纪要的成员<select aria-label="纪要成员" value={minutesDialog.memberId} disabled={minutesBusy} onChange={e=>setMinutesDialog({...minutesDialog,memberId:e.target.value})}>{minutesMembers.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>{minutesDialog.interrupt&&<p>正在进行的发言会先中止，已保存的发言保留。</p>}<p>预计 1 次调用。</p>{minutesError&&<p role="alert">{minutesError}</p>}</div><div className="modal-footer"><button className="button quiet" disabled={minutesBusy} onClick={()=>setMinutesDialog(undefined)}>取消</button><button className="button primary" disabled={minutesBusy||!minutesDialog.memberId} onClick={()=>void confirmMinutes()}>{minutesBusy?'正在处理…':'确认整理'}</button></div></Modal>}
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    {imageDialog&&<ImageGenerationDialog snapshot={snapshot} invoke={invoke} text={imageDialog.text} attachments={imageDialog.attachments} onClose={()=>setImageDialog(null)} onSent={()=>{setImageDialog(null);composer.clear(imageDialog.draftVersion);pinned.current=true;}}/>}
    {proposing && thread?.summary?.proposals?.length ? <MemoryProposalDialog snapshot={snapshot} thread={thread} invoke={invoke} onClose={() => setProposing(false)} /> : null}
    {handoff && <HandoffDialog snapshot={snapshot} invoke={invoke} source={handoff} onClose={() => setHandoff(null)} onDone={() => setHandoff(null)} />}
    {newTopic && <NewTopicDialog snapshot={personal?{...snapshot,room}:snapshot} personal={Boolean(personal)} current={current} from={newTopic.from} usable={writers} invoke={invoke} onClose={() => setNewTopic(null)} onDone={() => { setNewTopic(null); setPanel(false); afterTopicChange(); }} />}
  </Root>;
}
