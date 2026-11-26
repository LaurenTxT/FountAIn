import type { MemberCostMode, MemberProfile, Session } from './types';
import type { RequestedRunConfig } from './executor-config';

export type CostTier = 'casual' | 'meeting' | 'engineering' | 'review' | 'keyword_bump';

export interface CostRoutingContext {
  tier: CostTier;
  escalated?: boolean;
}

const ESCALATION_PATTERN = /(?:用\s*opus|换\s*opus|请\s*opus|深度复核|捉虫|找\s*bug|挑刺|排雷|深度检查|架构设计|出个?好点子|大工程)/i;
const COMPLEXITY_PATTERN = /```|Traceback \(most recent call last\)|(?:TypeError|SyntaxError|ReferenceError|ValueError|RuntimeError|AssertionError|Exception):|\bstack\s*trace\b/i;

export function normalizeCostMode(value: unknown): MemberCostMode {
  return value === 'economy' || value === 'on_demand' ? value : 'normal';
}

export function promptRequestsDeepReview(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (ESCALATION_PATTERN.test(trimmed)) return true;
  if (COMPLEXITY_PATTERN.test(trimmed)) return true;
  if (trimmed.length >= 120) return true;
  return false;
}

export function classifyCostTier(options: {
  purpose?: Session['purpose'];
  flowId?: string;
  isCasualRoom: boolean;
  isMeeting?: boolean;
  promptText?: string;
  isRetry?: boolean;
}): CostRoutingContext {
  if (options.isRetry) return { tier: 'review', escalated: true };
  if (options.purpose === 'flow-review' || options.purpose === 'flow-integration' || options.purpose === 'flow-plan') {
    return { tier: 'review' };
  }
  if (options.purpose === 'flow-task') {
    return { tier: 'engineering' };
  }
  if (options.isCasualRoom) {
    if (options.isMeeting) return { tier: 'meeting' };
    if (options.purpose === 'room-mention' || promptRequestsDeepReview(options.promptText)) {
      return { tier: 'keyword_bump' };
    }
    return { tier: 'casual' };
  }
  return { tier: 'review' };
}

function replacePreservingCase(input: string, from: RegExp, lowerReplacement: string, titleReplacement: string): string {
  return input.replace(from, (match) =>
    match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
      ? titleReplacement
      : lowerReplacement,
  );
}

function resolveLightModel(executor: string, raw: string, lower: string, customEconomyModel?: string): string | undefined {
  const custom = customEconomyModel?.trim();
  if (custom) return custom;
  if (executor === 'claude' || lower.includes('claude') || lower.includes('fable') || lower.includes('opus')) {
    return 'sonnet';
  }
  if (lower.includes('carbon')) return replacePreservingCase(raw, /carbon/gi, 'neon', 'Neon');
  if (lower.includes('neon')) return raw;
  if (executor.startsWith('acp-') && !raw) return 'gemini-4-neon';
  if (lower.includes('astra')) return replacePreservingCase(raw, /astra/gi, 'sol', 'Sol');
  if (/(?:^|[-_\s])sol(?:$|[-_\s])/.test(lower)) return raw;
  if (executor === 'codex') return raw && /(?:^|[-_\s])(?:mini|nano|sol)(?:$|[-_\s])/.test(lower) ? raw : 'gpt-6.2-sol';
  if (executor === 'dsh' || executor === 'deepseek' || lower.includes('deepseek')) return 'deepseek-flash';
  if (/pro/i.test(raw) && !/(?:^|[-_\s])(?:flash|lite|mini|neon)(?:$|[-_\s])/.test(lower)) {
    return replacePreservingCase(raw, /pro/gi, 'flash', 'Flash');
  }
  return raw || undefined;
}

/**
 * Pick the right model for a tier:
 * - casual:       Claude Sonnet | Gemini 4 Neon   | GPT-6.2-Sol   | DeepSeek-Flash
 * - keyword_bump: Claude Opus   | Gemini 4 Neon   | GPT-6.2-Sol   | DeepSeek-Flash
 * - engineering:  Claude Opus   | Gemini 4 Neon   | GPT-6.2-Sol   | DeepSeek-Flash
 * - review:       Claude Fable  | Gemini 4 Carbon | GPT-6.2-Astra | DeepSeek-V4-Pro
 * - escalated:    Claude Opus   | Gemini 4 Carbon (Medium) | GPT-6.2-Astra | DeepSeek-V4-Pro
 */
export function resolveTierModel(
  executor: string,
  tier: CostTier,
  currentModel?: string,
  overrides?: { economyModel?: string; engineeringModel?: string; escalated?: boolean },
): string | undefined {
  const raw = (currentModel ?? '').trim();
  const lower = raw.toLowerCase();

  if (tier === 'casual') {
    return resolveLightModel(executor, raw, lower, overrides?.economyModel);
  }

  if (tier === 'meeting') {
    if (executor === 'claude' || lower.includes('claude') || lower.includes('fable') || lower.includes('sonnet')) {
      return 'opus';
    }
    if (executor === 'dsh' || executor === 'deepseek' || lower.includes('deepseek')) {
      return 'deepseek-v4-pro';
    }
    return resolveLightModel(executor, raw, lower, overrides?.economyModel);
  }

  if (tier === 'keyword_bump') {
    if (executor === 'claude' || lower.includes('claude') || lower.includes('fable') || lower.includes('sonnet')) {
      return 'opus';
    }
    return resolveLightModel(executor, raw, lower, overrides?.economyModel);
  }

  if (tier === 'engineering') {
    const custom = overrides?.engineeringModel?.trim();
    if (custom) return custom;
    if (executor === 'claude' || lower.includes('claude') || lower.includes('fable') || lower.includes('sonnet')) {
      return 'opus';
    }
    return resolveLightModel(executor, raw, lower, overrides?.economyModel);
  }

  // review / architecture / inspiration (or escalated retry)
  if (executor === 'claude' || lower.includes('claude') || lower.includes('fable') || lower.includes('sonnet') || lower.includes('opus')) {
    return overrides?.escalated ? 'opus' : 'fable';
  }
  if (executor === 'codex') return raw && lower.includes('astra') ? raw : 'gpt-6.2-astra';
  if (executor === 'dsh' || executor === 'deepseek') return 'deepseek-v4-pro';
  if (lower.includes('neon')) {
    const upgraded = replacePreservingCase(raw, /neon/gi, 'carbon', 'Carbon');
    return overrides?.escalated && upgraded === 'gemini-4-carbon-low' ? 'gemini-4-carbon-medium' : upgraded;
  }
  if (executor.startsWith('acp-')) {
    if (!raw) return overrides?.escalated ? 'gemini-4-carbon-medium' : 'gemini-4-carbon-low';
    if (overrides?.escalated && lower === 'gemini-4-carbon-low') return 'gemini-4-carbon-medium';
  }
  return raw || undefined;
}

/** Backwards-compatible helper for casual tier resolution. */
export function resolveEconomyModel(
  executor: string,
  currentModel?: string,
  customEconomyModel?: string,
): string | undefined {
  return resolveTierModel(executor, 'casual', currentModel, { economyModel: customEconomyModel });
}

export function applyCostModeToConfig(
  config: RequestedRunConfig,
  member: Pick<MemberProfile, 'executor' | 'costMode' | 'economyModel' | 'engineeringModel'>,
  routing: boolean | CostRoutingContext,
): RequestedRunConfig {
  if (member.costMode !== 'economy') return config;
  const ctx: CostRoutingContext = typeof routing === 'boolean'
    ? { tier: routing ? 'casual' : 'review' }
    : routing;

  const nextModel = resolveTierModel(member.executor, ctx.tier, config.model, {
    economyModel: member.economyModel,
    engineeringModel: member.engineeringModel,
    escalated: ctx.escalated,
  }) ?? config.model;

  // Default to 'low' everywhere; automatically step up to 'medium' only when escalating a retry/correction.
  const nextEffort = ctx.escalated
    ? 'medium'
    : config.effort === 'none' || config.effort === 'minimal'
      ? config.effort
      : 'low';

  if (nextModel === config.model && nextEffort === config.effort) return config;
  return {
    ...config,
    model: nextModel,
    effort: nextEffort,
  };
}
