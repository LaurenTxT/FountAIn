import type { MemberCostMode, MemberProfile } from './types';
import type { RequestedRunConfig } from './executor-config';

export function normalizeCostMode(value: unknown): MemberCostMode {
  return value === 'economy' || value === 'on_demand' ? value : 'normal';
}

/**
 * Pick a lighter, lower-cost sibling model for casual chat / routine room discussion
 * while keeping full-power models for project tasks, code review, plans, and 1v1 desk work.
 */
export function resolveEconomyModel(
  executor: string,
  currentModel?: string,
  customEconomyModel?: string,
): string | undefined {
  const custom = customEconomyModel?.trim();
  if (custom) return custom;

  const raw = (currentModel ?? '').trim();
  const lower = raw.toLowerCase();

  if (executor === 'claude' || lower.includes('claude')) {
    if (!raw || lower === 'opus' || lower.includes('opus')) return 'sonnet';
    return raw;
  }

  if (executor === 'dsh' || executor === 'deepseek' || lower.includes('deepseek')) {
    if (!raw || lower.includes('pro') || lower.includes('reasoner')) return 'deepseek-flash';
    return raw;
  }

  if (executor === 'codex' || lower.startsWith('gpt-') || /^o[134](?:-|$)/.test(lower)) {
    if (!raw) return 'gpt-5.4-mini';
    if (lower.includes('mini') || lower.includes('nano')) return raw;
    if (/^gpt-5\.4(?:[-_ ]pro)?$/.test(lower)) return 'gpt-5.4-mini';
    if (/^gpt-5(?:[-_ ]pro)?$/.test(lower)) return 'gpt-5-mini';
    if (/^o3(?:-pro)?$/.test(lower)) return 'o4-mini';
    if (lower.endsWith('-pro')) return raw.slice(0, -4);
    return raw;
  }

  if (lower.includes('gemini') || lower.includes('pro')) {
    if (/(?:^|[-_\s])(?:flash|lite|mini)(?:$|[-_\s])/.test(lower)) return raw;
    if (/pro/i.test(raw)) return raw.replace(/pro/gi, 'flash');
  }

  return raw || undefined;
}

export function applyCostModeToConfig(
  config: RequestedRunConfig,
  member: Pick<MemberProfile, 'executor' | 'costMode' | 'economyModel'>,
  isCasualRoom: boolean,
): RequestedRunConfig {
  if (!isCasualRoom || member.costMode !== 'economy') return config;
  const lightModel = resolveEconomyModel(member.executor, config.model, member.economyModel);
  const nextModel = lightModel ?? config.model;
  const nextEffort = config.effort === 'none' || config.effort === 'minimal' ? config.effort : 'low';
  if (nextModel === config.model && nextEffort === config.effort) return config;
  return {
    ...config,
    model: nextModel,
    effort: nextEffort,
  };
}
