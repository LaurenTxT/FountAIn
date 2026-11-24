import type { Acceptance, Decision, Plan, ProjectFlow, Round } from './project-flow';

export const STUDY_AUTO_ROUND_LIMIT = 2;

export function canContinueStudyRound(input: {
  flow: ProjectFlow;
  plan: Plan;
  round: Round;
  previous: Round;
  acceptance: Acceptance;
  decision: Decision;
  verified: boolean;
  otherOpenDecision: boolean;
  newRequirements: boolean;
  automaticStarts: number;
}): boolean {
  const {flow, plan, round, previous, acceptance, decision} = input;
  const confirmation = round.nextConfirmation;
  const recommendation = confirmation?.recommendation;
  return plan.studyContinuation === 'authorized' &&
    plan.status === 'confirmed' && plan.flowId === flow.id &&
    flow.status === 'active' && flow.dispatchMode === 'running' &&
    flow.activePlanId === plan.id && flow.currentRoundId === round.id &&
    !flow.blockedReasons.length && round.planId === plan.id &&
    round.status === 'pending' && !round.startedAt && Boolean(round.baseVersion) &&
    previous.planId === plan.id && previous.status === 'accepted' && !previous.studyHandoffError &&
    previous.index + 1 === round.index && round.predecessorRoundId === previous.id &&
    previous.acceptanceId === acceptance.id && acceptance.roundId === previous.id &&
    acceptance.status === 'accepted' && previous.report !== undefined &&
    !previous.report.userDecisionNeeded.trim() && !previous.report.remainingIssues.length &&
    confirmation?.status === 'ready' && confirmation.previousRoundId === previous.id &&
    confirmation.acceptanceId === acceptance.id && confirmation.decisionId === decision.id &&
    recommendation?.mode === 'as-planned' && !recommendation.taskAdjustments.length &&
    !recommendation.completionCriteria?.length &&
    decision.flowId === flow.id && decision.roundId === round.id &&
    decision.kind === 'next-round' && decision.status === 'open' &&
    decision.options.includes('按原计划开始') &&
    decision.sourceVersions.length === 2 &&
    decision.sourceVersions[0].artifactId === acceptance.version.artifactId &&
    decision.sourceVersions[0].fingerprint === acceptance.version.fingerprint &&
    decision.sourceVersions[1].artifactId === round.baseVersion?.artifactId &&
    decision.sourceVersions[1].fingerprint === round.baseVersion?.fingerprint &&
    input.verified && !input.otherOpenDecision && !input.newRequirements &&
    input.automaticStarts < STUDY_AUTO_ROUND_LIMIT;
}
