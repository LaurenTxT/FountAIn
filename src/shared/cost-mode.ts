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
const NEGATED_MODEL_PREFIX = /(?:别|不要|不用|少用|别再用|不是|而非|而不是)\s*(?:用|换|切|改用|让|叫)?\s*$/i;
const PAST_MODEL_PREFIX = /(?:之前|刚才|刚刚|上次|原来|原本|以前)\s*(?:用|是|跑的|用的)?\s*$/i;
const EXPLICIT_SWITCH_PREFIX = /(?:改用|换成|换用|切到|切换成|切换到|切换|用|换|切|请|让|叫)\s*$/i;
const COMPARISON_PHRASE = /(?:对比|比较|区别|差异|哪个好|哪个强|哪个更|哪款|怎么样|好用吗|强吗|评测|测评|值得吗)/u;
const OVERRIDE_TRANSITION = /(?:换成|换用|改用|切到|切换成|切换到|这次|现在|直接用|就用)/u;

interface ModelCandidateSpec {
  model: string;
  effort?: RequestedRunConfig['effort'];
  regex: RegExp;
}

function collectModelHits(cleaned: string, specs: ModelCandidateSpec[]) {
  const hits: { index: number; model: string; effort?: RequestedRunConfig['effort']; explicit: boolean }[] = [];
  for (const spec of specs) {
    const re = new RegExp(spec.regex.source, spec.regex.flags.includes('g') ? spec.regex.flags : `${spec.regex.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) {
      const start = m.index;
      const prefix = cleaned.slice(Math.max(0, start - 12), start);
      if (NEGATED_MODEL_PREFIX.test(prefix)) continue;
      const isPast = PAST_MODEL_PREFIX.test(prefix);
      const explicit = !isPast && EXPLICIT_SWITCH_PREFIX.test(prefix);
      if (isPast) continue;
      hits.push({ index: start, model: spec.model, effort: spec.effort, explicit });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

export function parseExplicitModelOverride(
  executor: string,
  text?: string,
  modelOptions?: ModelOption[],
): { model?: string; effort?: RequestedRunConfig['effort'] } | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').trim();
  if (!cleaned) return undefined;
  const effortHint = requestedEffortFromText(cleaned);
  const exec = executor.toLowerCase();

  // Exact model ID match from provider's reported modelOptions (when prefixed by 用/换/切/model)
  if (modelOptions?.length && /(?:用|换|切|改用|使用|model)/i.test(cleaned)) {
    const optSpecs: ModelCandidateSpec[] = [...modelOptions]
      .filter((opt) => opt.id !== 'default' && opt.id.length >= 3)
      .sort((a, b) => b.id.length - a.id.length)
      .map((opt) => ({
        model: opt.id,
        effort: effortHint,
        regex: new RegExp(`(?<![A-Za-z0-9_-])${opt.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`, 'gi'),
      }));
    const optHits = collectModelHits(cleaned, optSpecs).filter((h) => h.explicit || /\bmodel\b/i.test(cleaned));
    if (optHits.length) {
      const distinct = new Set(optHits.map((h) => h.model)).size;
      if (!(distinct > 1 && COMPARISON_PHRASE.test(cleaned) && !OVERRIDE_TRANSITION.test(cleaned))) {
        const last = optHits[optHits.length - 1];
        return { model: last.model, effort: last.effort };
      }
    }
  }

  const specs: ModelCandidateSpec[] = [];
  if (exec.startsWith('acp-') || exec.includes('gemini')) {
    const tierSuffix = effortHint ?? 'low';
    specs.push(
      { model: `gemini-4-carbon-${tierSuffix}`, effort: undefined, regex: /碳基米|(?<![A-Za-z0-9_-])(?:gemini[\s-]*4[\s-]*)?carbon(?![A-Za-z0-9_-])/gi },
      { model: 'gemini-4-neon', effort: effortHint ?? 'low', regex: /氖基米|(?<![A-Za-z0-9_-])(?:gemini[\s-]*4[\s-]*)?neon(?![A-Za-z0-9_-])/gi },
      { model: `gemini-4-hydrogen-${tierSuffix}`, effort: undefined, regex: /氢基米|(?<![A-Za-z0-9_-])(?:gemini[\s-]*4[\s-]*)?hydrogen(?![A-Za-z0-9_-])/gi },
      { model: `gemini-4-argon-${tierSuffix}`, effort: undefined, regex: /氩基米|(?<![A-Za-z0-9_-])(?:gemini[\s-]*4[\s-]*)?argon(?![A-Za-z0-9_-])/gi },
    );
  } else if (exec === 'claude') {
    specs.push(
      { model: 'fable', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:claude[\s-]*)?fable(?![A-Za-z0-9_-])/gi },
      { model: 'opus', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:claude[\s-]*)?opus(?![A-Za-z0-9_-])/gi },
      { model: 'sonnet', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:claude[\s-]*)?sonnet(?![A-Za-z0-9_-])/gi },
      { model: 'haiku', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:claude[\s-]*)?haiku(?![A-Za-z0-9_-])/gi },
    );
  } else if (exec === 'codex') {
    specs.push(
      { model: 'gpt-6.2-astra', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:gpt[\s-]*6\.2[\s-]*)?astra(?![A-Za-z0-9_-])/gi },
      { model: 'gpt-6.2-sol', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:gpt[\s-]*6\.2[\s-]*)?sol(?![A-Za-z0-9_-])/gi },
      { model: 'gpt-6.1-terra', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:gpt[\s-]*6\.1[\s-]*)?terra(?![A-Za-z0-9_-])/gi },
      { model: 'gpt-6-luna', effort: effortHint, regex: /(?<![A-Za-z0-9_-])(?:gpt[\s-]*6[\s-]*)?luna(?![A-Za-z0-9_-])/gi },
    );
  } else if (exec === 'dsh' || exec === 'deepseek') {
    specs.push(
      { model: 'deepseek-v4-pro', effort: undefined, regex: /\bdeepseek-v4-pro\b|\bv4-?pro\b|(?<=(?:用|换|切|改用|请|让|叫)\s*)(?:deepseek[\s-]*)?(?:v4[\s-]*)?pro\b/gi },
      { model: 'deepseek-flash', effort: effortHint, regex: /\bdeepseek-flash\b|(?<=(?:用|换|切|改用|请|让|叫)\s*)(?:deepseek[\s-]*)?flash\b/gi },
    );
  }

  if (!specs.length) return undefined;
  const hits = collectModelHits(cleaned, specs);
  if (!hits.length) return undefined;

  const explicitHits = hits.filter((h) => h.explicit);
  if (explicitHits.length > 0) {
    const distinctExplicit = new Set(explicitHits.map((h) => h.model)).size;
    if (distinctExplicit > 1 && COMPARISON_PHRASE.test(cleaned) && !OVERRIDE_TRANSITION.test(cleaned)) {
      return undefined;
    }
    const last = explicitHits[explicitHits.length - 1];
    return { model: last.model, effort: last.effort };
  }

  // Bare model mentions without an explicit switch verb:
  // Do NOT switch when comparing/discussing multiple models or asking about model quality.
  const distinctBare = new Set(hits.map((h) => h.model)).size;
  if (distinctBare > 1 || COMPARISON_PHRASE.test(cleaned)) {
    return undefined;
  }
  const single = hits[0];
  return { model: single.model, effort: single.effort };
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
 * - review:       Claude Fable  | Gemini 4 Carbon | GPT-6.2-Sol   | DeepSeek-V4-Pro
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
  if (executor === 'codex') {
    if (overrides?.escalated) return raw && lower.includes('astra') ? raw : 'gpt-6.2-astra';
    return 'gpt-6.2-sol';
  }
  if (executor === 'dsh' || executor === 'deepseek') return 'deepseek-v4-pro';
  if (lower.includes('neon')) {
    const upgraded = replacePreservingCase(raw, /neon/gi, 'carbon', 'Carbon');
    return upgraded.replace(/-(?:low|medium|high|xhigh|max)$/i, '');
  }
  if (executor.startsWith('acp-')) {
    if (!raw) return 'gemini-4-carbon';
    if (lower.startsWith('gemini-4-carbon-')) return 'gemini-4-carbon';
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
