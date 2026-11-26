import type { MemberCostMode, MemberProfile, ModelOption, Session } from './types';
import type { RequestedRunConfig } from './executor-config';

export type CostTier = 'casual' | 'meeting' | 'engineering' | 'review' | 'keyword_bump';

export interface CostRoutingContext {
  tier: CostTier;
  escalated?: boolean;
  userText?: string;
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
  const userText = options.promptText;
  if (options.isRetry) return { tier: 'review', escalated: true, userText };
  if (options.purpose === 'flow-review' || options.purpose === 'flow-integration' || options.purpose === 'flow-plan') {
    return { tier: 'review', userText };
  }
  if (options.purpose === 'flow-task') {
    return { tier: 'engineering', userText };
  }
  if (options.isCasualRoom) {
    if (options.isMeeting) return { tier: 'meeting', userText };
    if (options.purpose === 'room-mention' || promptRequestsDeepReview(options.promptText)) {
      return { tier: 'keyword_bump', userText };
    }
    return { tier: 'casual', userText };
  }
  return { tier: 'review', userText };
}

function requestedEffortFromText(text: string): 'low' | 'medium' | 'high' | undefined {
  if (/(?:\bhigh\b|高思考|深度思考|拉满)/i.test(text)) return 'high';
  if (/(?:\bmedium\b|中思考|中等思考)/i.test(text)) return 'medium';
  if (/(?:\blow\b|低思考)/i.test(text)) return 'low';
  return undefined;
}

/**
 * Parse an explicit natural-language model request for a specific executor, e.g.
 * "碳基米你看看" -> gemini-4-carbon-low, "Claude 用 fable 写" -> fable, "GPT 切 astra" -> gpt-6.2-astra.
 */
export function parseExplicitModelOverride(
  executor: string,
  text?: string,
  modelOptions?: ModelOption[],
): { model?: string; effort?: RequestedRunConfig['effort'] } | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/```[\s\S]*?```/g, ' ').trim();
  if (!cleaned) return undefined;
  const effortHint = requestedEffortFromText(cleaned);
  const exec = executor.toLowerCase();

  // Exact model ID match from provider's reported modelOptions (when prefixed by 用/换/切/model)
  if (modelOptions?.length && /(?:用|换|切|改用|使用|model)/i.test(cleaned)) {
    const sorted = [...modelOptions].sort((a, b) => b.id.length - a.id.length);
    for (const opt of sorted) {
      if (opt.id === 'default' || opt.id.length < 3) continue;
      if (new RegExp(`(?<![A-Za-z0-9_-])${opt.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'i').test(cleaned)) {
        return { model: opt.id, effort: effortHint };
      }
    }
  }

  // Gemini / Antigravity: 碳基米/carbon, 氖基米/neon, 氢基米/hydrogen, 氩基米/argon
  if (exec.startsWith('acp-') || exec.includes('gemini')) {
    const tierSuffix = effortHint ?? 'low';
    if (/碳基米|(?:用|换|切|让|叫)\s*(?:gemini[\s-]*4[\s-]*)?carbon|\bgemini-4-carbon\b/i.test(cleaned)) {
      return { model: `gemini-4-carbon-${tierSuffix}`, effort: undefined };
    }
    if (/氖基米|(?:用|换|切|让|叫)\s*(?:gemini[\s-]*4[\s-]*)?neon|\bgemini-4-neon\b/i.test(cleaned)) {
      return { model: 'gemini-4-neon', effort: effortHint ?? 'low' };
    }
    if (/氢基米|(?:用|换|切|让|叫)\s*(?:gemini[\s-]*4[\s-]*)?hydrogen|\bgemini-4-hydrogen\b/i.test(cleaned)) {
      return { model: `gemini-4-hydrogen-${tierSuffix}`, effort: undefined };
    }
    if (/氩基米|(?:用|换|切|让|叫)\s*(?:gemini[\s-]*4[\s-]*)?argon|\bgemini-4-argon\b/i.test(cleaned)) {
      return { model: `gemini-4-argon-${tierSuffix}`, effort: undefined };
    }
  }

  // Claude: opus / fable / sonnet / haiku
  if (exec === 'claude') {
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:claude[\s-]*)?fable|\bfable\s*5\.2\b/i.test(cleaned)) return { model: 'fable', effort: effortHint };
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:claude[\s-]*)?opus|\bopus\s*5\.5\b/i.test(cleaned)) return { model: 'opus', effort: effortHint };
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:claude[\s-]*)?sonnet|\bsonnet\s*5\.5\b/i.test(cleaned)) return { model: 'sonnet', effort: effortHint };
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:claude[\s-]*)?haiku|\bhaiku\s*5\.5\b/i.test(cleaned)) return { model: 'haiku', effort: effortHint };
  }

  // GPT / Codex: astra / sol / terra / luna
  if (exec === 'codex') {
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:gpt[\s-]*6\.2[\s-]*)?astra|\bgpt-?6\.2-?astra\b/i.test(cleaned)) return { model: 'gpt-6.2-astra', effort: effortHint };
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:gpt[\s-]*6\.2[\s-]*)?sol|\bgpt-?6\.2-?sol\b/i.test(cleaned)) return { model: 'gpt-6.2-sol', effort: effortHint };
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:gpt[\s-]*6\.1[\s-]*)?terra|\bgpt-?6\.1-?terra\b/i.test(cleaned)) return { model: 'gpt-6.1-terra', effort: effortHint };
    if (/(?:用|换|切|改用|请|让|叫)\s*(?:gpt[\s-]*6[\s-]*)?luna|\bgpt-?6-?luna\b/i.test(cleaned)) return { model: 'gpt-6-luna', effort: effortHint };
  }

  // DeepSeek / DSH: v4-pro / flash
  if (exec === 'dsh' || exec === 'deepseek') {
    if (/\bdeepseek-v4-pro\b|(?:用|换|切|改用)\s*(?:deepseek[\s-]*)?(?:v4[\s-]*)?pro\b/i.test(cleaned)) return { model: 'deepseek-v4-pro', effort: undefined };
    if (/\bdeepseek-flash\b|(?:用|换|切|改用)\s*(?:deepseek[\s-]*)?flash\b/i.test(cleaned)) return { model: 'deepseek-flash', effort: effortHint };
  }

  return undefined;
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

function pickSupportedEffort(
  desired: RequestedRunConfig['effort'],
  model: string | undefined,
  modelOptions?: ModelOption[],
): RequestedRunConfig['effort'] {
  const lower = (model ?? '').toLowerCase();
  // Models that bake effort into the ID or do not take an effort flag at all.
  if (lower === 'deepseek-v4-pro' || /-(?:low|medium|high|xhigh)$/.test(lower)) {
    return undefined;
  }
  const opt = model && modelOptions?.find((item) => item.id === model || item.aliases?.includes(model));
  if (opt) {
    if (opt.effortSource === 'unsupported' || (opt.effortSource === 'reported' && !opt.efforts?.length)) {
      return undefined;
    }
    if (opt.efforts?.length) {
      if (desired && opt.efforts.includes(desired)) return desired;
      if (desired === 'medium' && opt.efforts.includes('high')) return 'high';
      if (opt.efforts.includes('low')) return 'low';
      return opt.efforts[0] as RequestedRunConfig['effort'];
    }
  }
  // Fallback for DeepSeek Flash when provider options haven't been loaded yet (supports off/low/high/max, no medium).
  if (lower === 'deepseek-flash' && desired === 'medium') return 'high';
  return desired;
}

export function applyCostModeToConfig(
  config: RequestedRunConfig,
  member: Pick<MemberProfile, 'executor' | 'costMode' | 'economyModel' | 'engineeringModel'>,
  routing: boolean | CostRoutingContext,
  modelOptions?: ModelOption[],
): RequestedRunConfig {
  const ctx: CostRoutingContext = typeof routing === 'boolean'
    ? { tier: routing ? 'casual' : 'review' }
    : routing;

  // Explicit natural-language model request always takes priority (even in normal mode).
  const explicit = parseExplicitModelOverride(member.executor, ctx.userText, modelOptions);
  if (explicit?.model) {
    const desired = explicit.effort ?? (config.effort === 'none' || config.effort === 'minimal' ? config.effort : 'low');
    const nextEffort = pickSupportedEffort(desired, explicit.model, modelOptions);
    return { ...config, model: explicit.model, effort: nextEffort };
  }

  if (member.costMode !== 'economy') return config;

  const nextModel = resolveTierModel(member.executor, ctx.tier, config.model, {
    economyModel: member.economyModel,
    engineeringModel: member.engineeringModel,
    escalated: ctx.escalated,
  }) ?? config.model;

  // Default to 'low' everywhere; automatically step up to 'medium' only when escalating a retry/correction,
  // and always clamp/strip effort to what the target model actually supports.
  const desiredEffort: RequestedRunConfig['effort'] = ctx.escalated
    ? 'medium'
    : config.effort === 'none' || config.effort === 'minimal'
      ? config.effort
      : 'low';
  const nextEffort = pickSupportedEffort(desiredEffort, nextModel, modelOptions);

  if (nextModel === config.model && nextEffort === config.effort) return config;
  return {
    ...config,
    model: nextModel,
    effort: nextEffort,
  };
}
