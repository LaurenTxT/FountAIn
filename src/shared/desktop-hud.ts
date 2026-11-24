import { balanceFresh, quotaFresh } from './quota';
import type { Snapshot } from './types';

export interface HudRow {
  memberId: string;
  providerId: string;
  name: string;
  executor: string;
  state: string;
  session: string;
  sessionId?: string;
  quota: string;
  tokens?: number;
  usageProvider?: 'agy' | 'claude';
  usageDetail?: string;
  usageCheckedAt?: number;
  usageMetrics?: { label: string; value: string }[];
}

export interface HudSnapshot {
  rows: HudRow[];
  apiRelay: boolean;
  attention: number;
}

export function sharedUsageFor(status: HudSnapshot | undefined, memberId: string, claudeApi: boolean): HudRow | undefined {
  const row = status?.rows.find(item => item.memberId === memberId);
  return row && (row.usageProvider === 'agy' || row.usageProvider === 'claude' && claudeApi) ? row : undefined;
}

const ACTIVE = new Set(['queued', 'running', 'waiting_user', 'stopping']);
const STATES: Record<string, string> = { queued: '排队中', running: '运行中', waiting_user: '等你处理', stopping: '停止中' };

function reportedTokens(data: unknown): number | undefined {
  const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const payload = record(data);
  const usage = record(payload.usage ?? record(payload.tokenUsage).last ?? payload);
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const total = count(usage.totalTokens ?? usage.total_tokens);
  const input = count(usage.inputTokens ?? usage.input_tokens);
  const output = count(usage.outputTokens ?? usage.output_tokens);
  if (total !== undefined) return total;
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0) +
    (count(usage.cache_read_input_tokens) ?? 0) + (count(usage.cache_creation_input_tokens) ?? 0);
}

export function desktopHud(snapshot: Snapshot | undefined): HudRow[] {
  if (!snapshot) return [];
  const sessions = new Map(snapshot.sessions.map(session => [session.id, session]));
  const now = Date.now();
  return snapshot.members.map(member => {
    const run = snapshot.runs.filter(item => {
      const session = sessions.get(item.sessionId);
      return session?.memberId === member.id || (!session?.memberId && item.provider === member.executor &&
        snapshot.members.filter(candidate => candidate.executor === member.executor).length === 1);
    }).sort((a, b) => Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.updatedAt.localeCompare(a.updatedAt))[0];
    const session = run && sessions.get(run.sessionId);
    const quota = snapshot.quotas?.[member.executor];
    const windows = quota?.windows.filter(window => quotaFresh(window, now) && (window.usedPercent !== undefined || window.exhausted)) ?? [];
    const balance = quota?.balance;
    const remaining = windows.length ? Math.round(Math.min(...windows.map(window => window.exhausted ? 0 : 100 - (window.usedPercent ?? 0)))) : undefined;
    const capacity = balance && balanceFresh(balance, now) && balance.wallets.length
      ? balance.wallets.map(wallet => wallet.currency + ' ' + wallet.balance).join(' / ')
      : remaining === undefined ? '额度未回报' : '最低剩余 ' + remaining + '%';
    const tokens = run && [...snapshot.events].reverse()
      .filter(event => event.runId === run.id && event.kind === 'usage')
      .map(event => reportedTokens(event.data)).find(value => value !== undefined);
    const provider = snapshot.providers.find(item => item.id === member.executor);
    const command = snapshot.executors?.find(item => item.id === member.executor)?.command ?? provider?.path ?? '';
    const antigravity = /antigravity/i.test(provider?.name ?? '') || /(?:^|[\\/])agy(?:\.exe)?$/i.test(command);
    const cleanName = (value: string) => /^codex$/i.test(value.trim()) ? 'ChatGPT' : value.replace(/\bcodex\b/gi, 'ChatGPT');
    return { memberId: member.id, providerId: member.executor, name: cleanName(member.name), executor: cleanName(provider?.name ?? member.executor), state: run && ACTIVE.has(run.status) ? STATES[run.status] : provider?.available === false ? '连接未就绪' : '待命',
      session: session?.title ?? '', sessionId: session?.id, quota: capacity, tokens,
      usageProvider: member.executor === 'claude' ? 'claude' : antigravity ? 'agy' : undefined };
  });
}

export function phoneHud(snapshot: Snapshot | undefined, rows = desktopHud(snapshot)) {
  return rows.map(({ executor, state, quota, tokens }) => ({ executor, state, quota, tokens }));
}
