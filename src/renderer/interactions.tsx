import { ConfigurationHint, useProviderConfiguration } from './provider-configuration';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Folder, Laptop, MessagesSquare, Search, Users } from 'lucide-react';
import { PROVIDER_NAMES } from '../shared/defaults';
import type { Approval, Project, RunSummary, Session, Snapshot } from '../shared/types';
import { Avatar, useTeam, type Team } from './members';
import { plainText } from './Markdown';
import { shortDateTime, runLabel, isActiveRun, sessionTitle } from './ui';
import { isConversationSession } from '../shared/session-classification';

/* ───────── Context menu ───────── */
export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean } | 'separator';
export type MenuState = { x: number; y: number; items: MenuItem[] } | null;

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const node = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!menu) return;
    const rect = node.current?.getBoundingClientRect();
    const width = rect?.width ?? 200, height = rect?.height ?? 200;
    setPosition({ x: Math.min(menu.x, window.innerWidth - width - 8), y: Math.min(menu.y, window.innerHeight - height - 8) });
    node.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: Event) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !node.current?.contains(event.target as Node)) onClose(); };
    const onScroll = (event: Event) => { if (!node.current?.contains(event.target as Node)) onClose(); };
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', close, true);
      document.addEventListener('mousedown', close, true);
      document.addEventListener('keydown', close);
      document.addEventListener('scroll', onScroll, true);
      window.addEventListener('blur', onClose);
      window.addEventListener('resize', onClose);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', close);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  return createPortal(<div className="context-menu" ref={node} role="menu" style={{ left: position.x, top: position.y }} onKeyDown={event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(node.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }}>
    {menu.items.map((item, index) => item === 'separator' ? <hr key={index} /> : <button type="button" role="menuitem" key={index} className={item.danger ? 'danger' : ''} disabled={item.disabled} onClick={() => { onClose(); item.onSelect(); }}>{item.icon}<span>{item.label}</span></button>)}
  </div>, document.body);
}

/* ───────── Quick switcher (Ctrl+K) ───────── */
export type QuickPickTarget =
  | { kind: 'session'; session: Session }
  | { kind: 'project'; project: Project }
  | { kind: 'desk'; memberId: string }
  | { kind: 'room' }
  | { kind: 'roundtable'; topicId?: string };

interface SwitcherEntry {
  key: string;
  target: QuickPickTarget;
  title: string;
  subtitle: string;
  badge: string;
  searchText: string;
  memberId?: string;
  icon?: ReactNode;
}

export function QuickSwitcher({ snapshot, firstInput, onPick, onClose }: { snapshot: Snapshot; firstInput: (id: string) => string | undefined; onPick: (target: QuickPickTarget) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const team = useTeam();
  const projects = useMemo(() => new Map(snapshot.projects.map(project => [project.id, project])), [snapshot.projects]);

  const entries = useMemo<SwitcherEntry[]>(() => {
    const list: SwitcherEntry[] = [];
    for (const project of snapshot.projects) {
      if (project.kind) continue;
      list.push({
        key: `project:${project.id}`,
        target: { kind: 'project', project },
        title: project.name,
        subtitle: project.directory,
        badge: '项目',
        searchText: `项目 project ${project.name} ${project.directory}`.toLowerCase(),
        icon: <Folder size={15} />,
      });
    }
    for (const member of team.members) {
      if (member.card.cardHidden) continue;
      const providerName = PROVIDER_NAMES[member.executor] ?? member.executor;
      list.push({
        key: `desk:${member.id}`,
        target: { kind: 'desk', memberId: member.id },
        title: `${member.name} 的工位`,
        subtitle: `${providerName} · 1v1 单独对话`,
        badge: '工位',
        searchText: `工位 desk ${member.name} ${member.id} ${providerName}`.toLowerCase(),
        memberId: member.id,
      });
    }
    list.push({
      key: 'room:tea',
      target: { kind: 'room' },
      title: '茶歇室',
      subtitle: snapshot.room.messages.length ? `${snapshot.room.messages.length} 条消息` : '多人闲聊或开会',
      badge: '房间',
      searchText: '茶歇室 群聊 聊天室 lounge room'.toLowerCase(),
      icon: <MessagesSquare size={15} />,
    });
    const topics = snapshot.roundtable?.topics ?? [];
    if (!topics.length) {
      list.push({
        key: 'roundtable:home',
        target: { kind: 'roundtable' },
        title: '圆桌',
        subtitle: '独立评审、比稿与方案比较',
        badge: '圆桌',
        searchText: '圆桌 评审 比稿 roundtable'.toLowerCase(),
        icon: <Users size={15} />,
      });
    } else {
      for (const topic of topics) {
        list.push({
          key: `roundtable:${topic.id}`,
          target: { kind: 'roundtable', topicId: topic.id },
          title: topic.title || '圆桌议题',
          subtitle: `圆桌 · ${shortDateTime(topic.updatedAt ?? topic.createdAt)}`,
          badge: '圆桌',
          searchText: `圆桌 roundtable ${topic.title ?? ''}`.toLowerCase(),
          icon: <Users size={15} />,
        });
      }
    }
    const sessions = [...snapshot.sessions]
      .filter(session => isConversationSession(session, snapshot.runs))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const session of sessions) {
      const m = team.ofSession(session);
      const title = sessionTitle(session, firstInput(session.id));
      const projectName = projects.get(session.projectId)?.name ?? '项目';
      list.push({
        key: `session:${session.id}`,
        target: { kind: 'session', session },
        title,
        subtitle: `${m.name} · ${projectName} · ${shortDateTime(session.updatedAt)}${session.archived ? ' · 已归档' : ''}`,
        badge: '会话',
        searchText: `会话 session ${title} ${m.name} ${PROVIDER_NAMES[session.provider] ?? session.provider} ${projectName}`.toLowerCase(),
        memberId: m.id,
      });
    }
    return list;
  }, [snapshot.projects, snapshot.roundtable, snapshot.room.messages.length, snapshot.sessions, snapshot.runs, projects, firstInput, team]);

  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return entries.slice(0, 30);
    const matched = entries.filter(item => words.every(word => item.searchText.includes(word)));
    const msgMatches: SwitcherEntry[] = [];
    for (let i = snapshot.room.messages.length - 1; i >= 0 && msgMatches.length < 8; i--) {
      const msg = snapshot.room.messages[i];
      if (!msg.text || msg.system) continue;
      const body = plainText(msg.text);
      const hay = `${msg.authorName ?? ''} ${body}`.toLowerCase();
      if (words.every(word => hay.includes(word))) {
        msgMatches.push({
          key: `msg:${msg.id}`,
          target: { kind: 'room' },
          title: body.slice(0, 64) + (body.length > 64 ? '…' : ''),
          subtitle: `茶歇室 · ${msg.authorName || msg.author} · ${shortDateTime(msg.at)}`,
          badge: '消息',
          searchText: hay,
          icon: <MessagesSquare size={15} />,
        });
      }
    }
    return [...matched, ...msgMatches].slice(0, 30);
  }, [query, entries, snapshot.room.messages]);

  useEffect(() => setIndex(0), [query]);
  return <div className="modal-overlay switcher-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="switcher" role="dialog" aria-modal="true" aria-label="快速搜索与跳转">
      <label className="switcher-search"><Search size={16} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目、工位、茶歇室、圆桌、会话或聊天内容…" aria-label="快速搜索"
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.min(value + 1, Math.max(0, results.length - 1))); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(value - 1, 0)); }
          else if (event.key === 'Enter' && results[index]) { event.preventDefault(); onPick(results[index].target); }
        }} /><kbd>Esc</kbd></label>
      <div className="switcher-list" role="listbox">
        {!results.length && <div className="switcher-empty">没有找到匹配的项目、房间或消息</div>}
        {results.map((item, position) => <button type="button" role="option" aria-selected={position === index} key={item.key} className={`switcher-item ${item.memberId ? `member-${item.memberId}` : ''} ${position === index ? 'active' : ''}`} onMouseEnter={() => setIndex(position)} onClick={() => onPick(item.target)}>
          {item.memberId ? <Avatar member={team.get(item.memberId)} size={28} ring={false} /> : <span className="switcher-icon">{item.icon ?? <Laptop size={15} />}</span>}
          <span><strong>{item.title}</strong><small>{item.badge} · {item.subtitle}</small></span>
          {position === index && <CornerDownLeft size={14} />}
        </button>)}
      </div>
      <div className="switcher-hint"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 打开</span><span><kbd>Ctrl</kbd>+<kbd>N</kbd> 新会话</span><span><kbd>Ctrl</kbd>+<kbd>,</kbd> 设置</span></div>
    </div>
  </div>;
}

/* ───────── Desktop notifications ───────── */
export const NOTIFY_KEY = 'fountain.notify';
export const notificationsEnabled = () => { try { return localStorage.getItem(NOTIFY_KEY) !== 'off'; } catch { return true; } };

/** Tell the user when a member finishes or needs them while FountAIn is in the background. */
export function useMemberNotifications(snapshot: Snapshot, firstInput: (id: string) => string | undefined, onOpen: (session: Session) => void, team: Team) {
  const previous = useRef<{ runs: Map<string, RunSummary['status']>; approvals: Set<string> } | null>(null);
  useEffect(() => {
    const runs = new Map(snapshot.runs.map(run => [run.id, run.status]));
    const approvals = new Set(snapshot.approvals.filter(approval => approval.state === 'pending').map(approval => approval.id));
    const before = previous.current;
    previous.current = { runs, approvals };
    if (!before || !snapshot.backendReady || document.hasFocus() || !notificationsEnabled()) return;
    const sessions = new Map(snapshot.sessions.map(session => [session.id, session]));
    const notices: { session: Session; title: string; body: string }[] = [];
    for (const run of snapshot.runs) {
      const was = before.runs.get(run.id);
      const session = sessions.get(run.sessionId);
      if (!session || !was || was === run.status) continue;
      const name = team.ofSession(session).name, topic = sessionTitle(session, firstInput(session.id));
      const room = snapshot.projects.find(project => project.id === session.projectId)?.kind === 'lounge';
      if (run.status === 'ended' && run.completedAt) notices.push({ session, title: room ? `${name} 在聊天室说话了` : `${name} 完成了`, body: room ? '点开茶歇室查看' : topic });
      else if (['failed', 'unknown', 'interrupted'].includes(run.status)) notices.push({ session, title: `${name} 没能完成`, body: `${topic} · ${runLabel(run)}` });
      else if (run.status === 'rate_limited' && run.completedAt) notices.push({ session, title: `${name} 的额度受限`, body: topic });
    }
    for (const approval of snapshot.approvals as Approval[]) {
      if (approval.state !== 'pending' || before.approvals.has(approval.id)) continue;
      const session = sessions.get(approval.sessionId); if (!session) continue;
      notices.push({ session, title: `${team.ofSession(session).name} 在等你回应`, body: approval.type === 'question' ? approval.detail || approval.title : approval.title });
    }
    if (!notices.length) return;
    void window.fountain?.invoke('window.attention').catch(() => {});
    for (const notice of notices.slice(0, 3)) {
      try {
        const shown = new Notification(notice.title, { body: notice.body.slice(0, 180), icon: team.ofSession(notice.session).art, tag: notice.session.id, silent: false });
        shown.onclick = () => { void window.fountain?.invoke('window.show').catch(() => {}); onOpen(notice.session); shown.close(); };
      } catch { /* Notifications unavailable: the taskbar flash still signals. */ }
    }
  }, [snapshot.runs, snapshot.approvals, snapshot.sessions, snapshot.projects, snapshot.backendReady, firstInput, onOpen, team]);
}

export const isBusy = (snapshot: Snapshot, sessionId: string) => snapshot.runs.some(run => run.sessionId === sessionId && (isActiveRun(run) || run.status === 'queued'));

/* ───────── Per-session model picker ───────── */
const EFFORT_NAMES: Record<string, string> = { on: '开启', none: '关闭', off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '超高' };
export function ModelPopover({ anchor, session, info, defaults, onSave, onSettings, onClose, invoke }: {
  invoke?: import('./ui').Invoke; anchor: DOMRect; session: Session; info?: import('../shared/types').ProviderInfo; defaults: { model?: string; effort?: string };
  onSave: (change: { model: string | null; effort: string | null }) => void; onSettings: () => void; onClose: () => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const [model, setModel] = useState(session.model ?? '');
  const [effort, setEffort] = useState(session.effort ?? '');
  useEffect(() => {
    const close = (event: Event) => { if (event instanceof KeyboardEvent ? event.key === 'Escape' : !node.current?.contains(event.target as Node)) onClose(); };
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', close, true);
      document.addEventListener('mousedown', close, true);
      document.addEventListener('keydown', close);
      window.addEventListener('resize', onClose);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', close);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const configuration = useProviderConfiguration(session.provider, info, model || defaults.model, invoke);
  const { options, efforts } = configuration;
  const defaultModel = defaults.model || options.find(option => option.isDefault)?.label || info?.model || '成员默认';
  return createPortal(<div className="model-popover" ref={node} role="dialog" aria-label="这个会话的模型" style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 8 }}>
    <strong>这个会话用哪个模型</strong>
    <label className="field compact">模型
      {options.length ? <select disabled={!configuration.modelConfigurable} value={model} onChange={event => setModel(event.target.value)}>
        <option value="">跟随成员默认（{defaultModel}）</option>
        {options.map(option => <option key={option.id} value={option.id}>{option.label}{option.isDefault ? ' · 默认' : ''}</option>)}
        {model && !options.some(option => option.id === model) && <option value={model}>{model}</option>}
      </select> : <input disabled={!configuration.modelConfigurable} value={model} onChange={event => setModel(event.target.value)} placeholder={`留空跟随成员默认（${defaultModel}）`} spellCheck={false} />}
    </label>
    <label className="field compact">思考程度
      <select disabled={configuration.checking} value={effort} onChange={event => setEffort(event.target.value)}>
        <option value="">跟随成员默认{defaults.effort ? `（${EFFORT_NAMES[defaults.effort] ?? defaults.effort}）` : ''}</option>
        {[...efforts, ...(effort && !efforts.includes(effort) ? [effort] : [])].map(value => <option key={value} value={value}>{EFFORT_NAMES[value] ?? value}（{value}）{!efforts.includes(value) ? '（需重新核对）' : ''}</option>)}
      </select>
    </label>
    <ConfigurationHint configuration={configuration} onDefault={model ? () => { setModel(''); setEffort(''); } : undefined} />
    <small>只影响这个会话，从下一轮开始生效。</small>
    <div className="model-popover-actions">
      <button type="button" className="link-button" onClick={() => { onClose(); onSettings(); }}>修改成员默认</button>
      <button type="button" className="button small primary" onClick={() => { onSave({ model: model || null, effort: effort || null }); onClose(); }}>保存</button>
    </div>
  </div>, document.body);
}
