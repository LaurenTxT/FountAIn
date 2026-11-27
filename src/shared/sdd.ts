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
  constitutionText?: string;
  specText?: string;
  specCriteria?: string[];
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
  'sdd.constitution.save',
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

/** Extract checklist acceptance criteria (`- [ ] ...` / `- [x] ...`) from spec.md. */
export function extractSpecCriteria(specText?: string): string[] {
  if (!specText) return [];
  const items: string[] = [];
  for (const line of specText.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[[ xX]\]\s+(.+?)\s*$/);
    if (m && m[1].trim()) items.push(m[1].trim());
  }
  return [...new Set(items)];
}

export const DEFAULT_CONSTITUTION_TEMPLATE = `# 项目技术宪法 (Constitution)

> 本文件保存本项目的长期硬性规范，每一轮 SDD（起草 Spec、双盲提案、合成方案与任务拆解）都会自动带入。

## 1. 技术栈与目录边界
- 严禁硬编码本机绝对路径，所有文件读写使用项目相对路径。
- 修改已有代码前先核实现状，不顺手重构无关模块。

## 2. 质量与验证红线
- 涉及逻辑或接口改动必须经过类型检查与对应测试验证。
- 被用户纠正或审查退回的同类问题，优先沉淀为自动化测试/守卫。

## 3. 安全与隐私红线
- 公开仓库与外发产物不得包含个人路径、密钥、账号或隐私信息。
`;
