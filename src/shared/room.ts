import {readableContent} from './content-presentation';
import type { MemberProfile, RoomMessage, RoomThread } from './types';

export const DEFAULT_ROOM_THREAD = 'room-main';
export const ROOM_PAGE_SIZE = 100;

/** A local title, with no extra model call and no split surrogate pairs. */
export function firstMessageTitle(text:string,members:Pick<MemberProfile,'id'|'name'>[]=[]){
  let body=text.trim();
  const names=members.flatMap(member=>[member.name,...(member.id==='dsh'?['DS','DSH']:[])]).filter(Boolean).sort((a,b)=>b.length-a.length);
  while(/^[@＠]/u.test(body)){
    const rest=body.slice(1),name=names.find(name=>rest.toLowerCase().startsWith(name.toLowerCase())&&!/[A-Za-z0-9_]/.test(rest[name.length]??''));
    if(!name)break;
    body=rest.slice(name.length).replace(/^[\s，,:：、]+/u,'');
  }
  return [...body.replace(/\s+/gu,' ').trim()].slice(0,20).join('');
}

/** Resolve the text again on the backend; a client cannot choose recipients through metadata. */
export function roomMentions(text: string, members: Pick<MemberProfile, 'id' | 'name'>[]) {
  // Built-in aliases follow the member identity even when its display name changes.
  const names = members.flatMap(member => [...new Set([member.name,...(member.id === 'dsh' ? ['DS','DSH'] : [])])].map(name=>({id:member.id,name}))).sort((a,b)=>b.name.length-a.name.length);
  const ids: string[] = [], unknown: string[] = [], ambiguous: string[] = [];
  for (let offset = 0; offset < text.length; offset++) {
    if (!'@＠'.includes(text[offset])) continue;
    const rest = text.slice(offset + 1), folded = rest.toLowerCase();
    // An email address is ordinary text; a name directly after English prose still counts.
    if (offset && /[A-Za-z0-9_.+-]/.test(text[offset - 1]) && /^[A-Za-z0-9._+-]+\.[A-Za-z]{2,}(?![A-Za-z0-9_.-])/.test(rest)) continue;
    const matches = names.filter(member => folded.startsWith(member.name.toLowerCase()) && !/[A-Za-z0-9_]/.test(rest[member.name.length] ?? ''));
    if (matches.length) {
      const longest = matches.filter(member => member.name.length === matches[0].name.length);
      if (new Set(longest.map(member=>member.id)).size > 1) ambiguous.push(longest[0].name);
      else if (!ids.includes(longest[0].id)) ids.push(longest[0].id);
      offset += longest[0].name.length;
    } else {
      const token = rest.match(/^[^\s@＠，。！？、,:;：；!?()[\]{}<>]+/u)?.[0];
      unknown.push(token ? token.slice(0, 40) : '（未填写名字）');
    }
  }
  return { ids, unknown: [...new Set(unknown)], ambiguous: [...new Set(ambiguous)] };
}

function naturalMemberAliases(member: Pick<MemberProfile, 'id' | 'name'> & { executor?: string }): string[] {
  const aliases = new Set<string>();
  if (member.name?.trim()) aliases.add(member.name.trim());
  const lowName = (member.name ?? '').toLowerCase();
  const exec = (member.executor ?? member.id).toLowerCase();
  if (exec === 'claude' || lowName.includes('claude')) {
    for (const a of ['Claude', '小克', '克劳德']) aliases.add(a);
  }
  if (exec === 'codex' || lowName.includes('chatgpt') || lowName.includes('codex') || lowName === 'gpt') {
    for (const a of ['ChatGPT', 'GPT', 'Codex']) aliases.add(a);
  }
  if (exec === 'dsh' || exec === 'deepseek' || lowName.includes('deepseek')) {
    for (const a of ['DeepSeek', 'DS', 'DSH', '大肥鱼']) aliases.add(a);
  }
  if (lowName.includes('gemini') || exec.includes('gemini')) {
    for (const a of ['Gemini', '哈基米', '氖基米', '碳基米', '氢基米', '氩基米']) aliases.add(a);
  }
  return [...aliases];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Detect seated members addressed naturally by name without `@`, e.g.
 * "Claude 帮我看看", "让 DeepSeek 和 GPT 评一下", "问问 Gemini 怎么改".
 * Ignores code blocks, inline code, model IDs like `gpt-6.2-sol`, and file paths.
 */
export function roomNaturalMentions(text: string, members: (Pick<MemberProfile, 'id' | 'name'> & { executor?: string })[]): string[] {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .trim();
  if (!stripped) return [];

  // Build unique alias -> memberId map (skip ambiguous aliases shared by multiple members).
  const aliasOwners = new Map<string, Set<string>>();
  for (const member of members) {
    for (const alias of naturalMemberAliases(member)) {
      const key = alias.toLowerCase();
      if (!aliasOwners.has(key)) aliasOwners.set(key, new Set());
      aliasOwners.get(key)!.add(member.id);
    }
  }
  const uniqueAliases: { alias: string; id: string }[] = [];
  for (const member of members) {
    for (const alias of naturalMemberAliases(member)) {
      if (aliasOwners.get(alias.toLowerCase())?.size === 1) {
        uniqueAliases.push({ alias, id: member.id });
      }
    }
  }
  if (!uniqueAliases.length) return [];
  uniqueAliases.sort((a, b) => b.alias.length - a.alias.length);

  const hits: { index: number; id: string }[] = [];
  const usedRanges: [number, number][] = [];
  const overlaps = (start: number, end: number) => usedRanges.some(([s, e]) => start < e && end > s);

  for (const { alias, id } of uniqueAliases) {
    const isAscii = /^[A-Za-z0-9]+$/.test(alias);
    // Avoid matching model IDs / paths like `gpt-6.2-sol`, `claude.exe`, `deepseek-flash`
    const pattern = isAscii
      ? new RegExp(`(?<![A-Za-z0-9_./\\\\-])${escapeRe(alias)}(?![A-Za-z0-9_./\\\\-])`, 'gi')
      : new RegExp(escapeRe(alias), 'g');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(stripped))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const before = stripped.slice(0, start);
      const after = stripped.slice(end);
      // Direct address signals:
      // 1. At start of sentence (optionally after 喂/嘿/请/让/叫/问问/帮我让/交给/和/跟/、)
      const leadCall = /(?:^|[\n，,。！？!?\s])(?:喂|嘿|哈喽|你好|那个|麻烦|辛苦|请|让|叫|找|问问|问下|交给|帮我让|帮我叫|帮我问|和|跟|以及|、)?\s*$/u.test(before);
      // 2. Followed by comma/space/question/action verb ("Claude，..." / "Claude 你看看" / "Claude 怎么看" / "Claude 呢")
      const trailCall = /^(?:\s*[，,:：、!?！？]|\s*(?:你|您|你们|来|帮|看|说|讲|写|改|查|测|评|分析|解释|回答|处理|做|弄|负责|继续|呢|吧|啊|呀|吗|怎么|咋|觉得|认为|有没有|能不能|可以|先|再|去|跟|和)|\s*$)/u.test(after);
      if (leadCall || trailCall) {
        usedRanges.push([start, end]);
        hits.push({ index: start, id });
      }
    }
  }

  hits.sort((a, b) => a.index - b.index);
  return [...new Set(hits.map(h => h.id))];
}

export const isRoomPass = (text: string) => text.trim() === '[PASS]';

/** The few reactions everyone shares; a fixed set keeps their meaning clear. */
export const ROOM_REACTIONS = [
  { emoji: '👍', label: '同意' }, { emoji: '❤️', label: '喜欢' }, { emoji: '😄', label: '好笑' },
  { emoji: '👀', label: '看到了' }, { emoji: '❓', label: '有疑问' },
] as const;
const fold = (value: string) => value.replace(/\uFE0F/g, '');
/** A reply that is only a reaction: the marker [REACT 👍] or the bare emoji. Anything more is a normal reply. */
export function roomReaction(text: string): string | undefined {
  const trimmed = text.trim(), marker = trimmed.match(/^\[REACT\s*([^\]]+?)\s*\]$/i);
  const value = fold(marker ? marker[1] : trimmed);
  return ROOM_REACTIONS.find(item => fold(item.emoji) === value)?.emoji;
}
/** A streamed reply that may still turn into [PASS] or a [REACT …] marker; shown only once it is clearly text. */
export const roomMarkerPending = (text: string) => { const trimmed = text.trim(); return trimmed.startsWith('[') && trimmed.length <= 16 && !trimmed.slice(1).includes('['); };
export function toggleReaction(reactions: Record<string, string[]> | undefined, emoji: string, author: string, on?: boolean) {
  const next = { ...(reactions ?? {}) }, authors = next[emoji] ?? [], present = authors.includes(author);
  const add = on ?? !present;
  if (add && !present) next[emoji] = [...authors, author];
  else if (!add && present) next[emoji] = authors.filter(item => item !== author);
  if (!next[emoji]?.length) delete next[emoji];
  return Object.keys(next).length ? next : undefined;
}
export const reactionText = (reactions: Record<string, string[]> | undefined, name: (author: string) => string) =>
  Object.entries(reactions ?? {}).map(([emoji, authors]) => `${emoji} ${authors.map(name).join('、')}`).join('；');

export function roomMarkdown(thread: RoomThread, messages: RoomMessage[], name: (author: string) => string) {
  const date = (at: string) => new Date(at).toLocaleString('zh-CN', { hour12: false });
  const lines = [`# ${thread.title.replace(/[\r\n]/g, ' ')}`, '', `- 创建时间：${date(thread.createdAt)}`, ...(thread.archivedAt ? [`- 归档时间：${date(thread.archivedAt)}`] : []), ''];
  if (thread.inherited) lines.push(`## 延续「${thread.inherited.title.replace(/[\r\n]/g, ' ')}」的摘要`, '', thread.inherited.text, '');
  if (thread.summary) lines.push(`## 话题摘要（${thread.summary.byName ?? '成员'}整理于 ${date(thread.summary.at)}，覆盖 ${thread.summary.count} 条）`, '', thread.summary.text, '');
  for (const message of messages) {
    if (message.discussionControl || message.contextOnly) continue;
    const speaker = (message.authorName ?? name(message.author)).replace(/[\r\n]/g, ' ');
    const label = message.kind === 'summary' ? ' · 会议总结' : message.status === 'passed' ? message.reaction ? ' · 表情回应' : ' · 未发言' : message.status === 'failed' ? ' · 未完成' : message.status === 'stopped' ? ' · 已停止' : '';
    lines.push('---', '', `## ${speaker}${label} · ${date(message.at)}`, '', message.status === 'passed' ? message.reaction ? `（用 ${message.reaction} 回应）` : '（选择不发言）' : (message.author==='user'?message.text:readableContent(message.text)) || '（没有正文）', '');
    if (message.reactions) lines.push(`> 回应：${reactionText(message.reactions, name)}`, '');
    if (message.error) lines.push(`> ${message.error}`, '');
    for (const file of message.attachments ?? []) lines.push(`> 附件：${file.name}`);
    for (const image of message.generatedImages ?? []) lines.push(`> 生成的图片：${image.name}`);
    if (message.attachments?.length || message.generatedImages?.length) lines.push('');
    if(message.memberReport){
      const report=message.memberReport;
      for(const task of report.tasks)lines.push(`- 任务：${task.title}（${task.status}）`,...task.files.map(file=>`  - 文件：${file}`));

      lines.push(...report.remaining.map(s=>`- 遗留：${s}`),...report.next.map(s=>`- 下一步：${s}`),'');
    }
  }
  return lines.join('\n');
}
