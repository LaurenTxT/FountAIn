import { readFileSync, statSync } from 'node:fs';
import type { HudRow } from '../shared/desktop-hud';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export interface RelayBilling {
  today?: number;
  total?: number;
  remaining?: number;
  checkedAt: number;
}

export function relayBillingConfigured(mode?: string, base?: string): boolean {
  if (mode !== 'api' || !base) return false;
  try {
    const url = new URL(base);
    return url.protocol === 'https:' && url.hostname !== 'api.anthropic.com';
  } catch {
    return false;
  }
}

export async function readRelayBilling(base: string, key: string, request: (url: string, options: RequestInit) => Promise<Response>): Promise<RelayBilling> {
  const origin = new URL(base).origin;
  const endpoint = new URL('/v1/usage', origin);
  endpoint.searchParams.set('timezone', 'Asia/Shanghai');
  const response = await request(endpoint.toString(), {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000), redirect: 'error', cache: 'no-store',
  });
  if (!response.ok) throw new Error('API 服务商账单查询失败（HTTP ' + response.status + '）');
  const document = object(await response.json());
  const usage = object(document.usage);
  const today = amount(object(usage.today).actual_cost);
  const total = amount(object(usage.total).actual_cost);
  const remaining = amount(document.remaining);
  if (today === undefined && total === undefined && remaining === undefined) throw new Error('API 服务商没有返回可核对的账单金额。');
  return { today, total, remaining, checkedAt: Date.now() };
}

export function applyUsageSources(rows: HudRow[], quotaFile?: string, billing?: RelayBilling, apiRelay = false): HudRow[] {
  let agy: { metrics: NonNullable<HudRow['usageMetrics']>; checkedAt: number; details: string[] } | undefined;
  if (quotaFile) {
    try {
      const file = statSync(quotaFile);
      if (file.isFile() && file.size <= 32_768 && Date.now() - file.mtimeMs <= 15 * 60_000) {
        const buckets = object(JSON.parse(readFileSync(quotaFile, 'utf8')));
        const details = ['gemini-5h', 'gemini-weekly'].flatMap((key, index) => {
          const bucket = object(buckets[key]);
          const remaining = amount(bucket.remaining_fraction);
          if (remaining === undefined || remaining > 1 || bucket.disabled === true) return [];
          if (typeof bucket.reset_time === 'string' && Date.parse(bucket.reset_time) <= Date.now()) return [];
          const reset = typeof bucket.reset_time === 'string' && Number.isFinite(Date.parse(bucket.reset_time))
            ? ' · ' + new Date(bucket.reset_time).toLocaleString('zh-CN') + ' 重置' : '';
          const label = index === 0 ? '5 小时剩余' : '本周剩余';
          const value = (remaining * 100).toFixed(1) + '%';
          return [{ label, value, reset }];
        });
        if (details.length) agy = { metrics: details.map(({ label, value }) => ({ label, value })), checkedAt: file.mtimeMs, details: details.filter(item => item.reset).map(item => item.label + item.reset) };
      }
    } catch { /* No usable official report yet. */ }
  }
  const time = (at: number) => new Date(at).toLocaleTimeString('zh-CN');
  const dollars = (n: number) => '$' + n.toFixed(4);
  return rows.map(row => {
    if (row.usageProvider === 'agy' && agy) return { ...row, quota: '本机 Antigravity · ' + agy.metrics.map(metric => metric.label + ' ' + metric.value).join(' / '), usageMetrics: agy.metrics, usageCheckedAt: agy.checkedAt, usageDetail: [...agy.details, '采集于 ' + time(agy.checkedAt)].join('；') };
    if (row.usageProvider === 'agy') return { ...row, quota: '请刷新 Antigravity 额度' };
    if (row.usageProvider !== 'claude' || !apiRelay) return row;
    if (!billing) return { ...row, quota: 'API 账单 · 尚未查询' };
    const totals = [
      ...(billing.today === undefined ? [] : [{ label: '今日扣费', value: dollars(billing.today) }]),
      ...(billing.total === undefined ? [] : [{ label: '累计扣费', value: dollars(billing.total) }]),
      ...(billing.remaining === undefined ? [] : [{ label: '剩余额度', value: dollars(billing.remaining) }]),
    ];
    return { ...row, quota: 'API 账单 · ' + totals.map(metric => metric.label + ' ' + metric.value).join(' / '), usageMetrics: totals, usageCheckedAt: billing.checkedAt, usageDetail: '按 API Key 计费 · 更新于 ' + time(billing.checkedAt) };
  });
}
