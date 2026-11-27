export type SddStage =
  | 'idle'
  | 'spec_drafting'
  | 'spec_review'
  | 'blind_proposing'
  | 'synthesizing'
  | 'plan_review'
  | 'tasks_ready';

export interface SddProposalSlot {
  memberId: string;
  memberName: string;
  role: 'lead' | 'advisor';
  status: 'pending' | 'running' | 'done' | 'failed';
  text?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface SddState {
  projectId: string;
  stage: SddStage;
  sddRelDir: string;
  requirement: string;
  leadMemberId: string;
  advisorMemberId?: string;
  specText?: string;
  leadProposal?: SddProposalSlot;
  advisorProposal?: SddProposalSlot;
  planText?: string;
  tasksText?: string;
  userDecisionNote?: string;
  error?: string;
  updatedAt: string;
}

export const SDD_RPC_METHODS = [
  'sdd.get',
  'sdd.spec.draft',
  'sdd.spec.save',
  'sdd.blind.start',
  'sdd.plan.save',
  'sdd.approve',
  'sdd.reset',
] as const;

export function resolveSddRelDir(hasDraftsDir: boolean): string {
  return hasDraftsDir ? '01_Drafts_and_Code/sdd' : '.fountain/sdd';
}
