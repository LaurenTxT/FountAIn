import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemberProfile, Project } from '../shared/types';
import type { ProjectFlow, Task } from '../shared/project-flow';
import { extractSpecCriteria, resolveSddRelDir, type SddState } from '../shared/sdd';
import type { Store } from './store';

export interface SddHost {
  changed(): void;
  runIsolatedReadOnly(
    projectId: string,
    member: MemberProfile,
    title: string,
    prompt: string,
  ): Promise<{ text: string; status: string; error?: string }>;
  startProjectFlow(params: {
    projectId: string;
    leadMemberId: string;
    memberIds: string[];
    reviewLevel?: string;
    topic: string;
  }): Promise<unknown>;
}

const now = () => new Date().toISOString();

export class SddController {
  private activeOps = new Set<string>();
  constructor(private store: Store, private host: SddHost) {}

  private project(projectId: string): Project {
    const project = this.store.get<Project>('projects', projectId);
    if (!project) throw new Error('找不到该项目。');
    return project;
  }

  private member(memberId: string): MemberProfile {
    const member = this.store.members().find((m) => m.id === memberId);
    if (!member) throw new Error('找不到所选成员。');
    return member;
  }

  private sddRelDir(project: Project): string {
    const hasDrafts = existsSync(path.join(project.directory, '01_Drafts_and_Code'));
    return resolveSddRelDir(hasDrafts);
  }

  private async readDoc(project: Project, relDir: string, name: string): Promise<string | undefined> {
    const file = path.join(project.directory, relDir, name);
    if (!existsSync(file)) return undefined;
    try {
      return await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  private async writeDoc(project: Project, relDir: string, name: string, content: string): Promise<string> {
    const dir = path.join(project.directory, relDir);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    await writeFile(file, content, 'utf8');
    return `${relDir}/${name}`;
  }

  private save(state: SddState): SddState {
    const next = { ...state, updatedAt: now() };
    this.store.put('sdd_states', next.projectId, next);
    this.host.changed();
    return next;
  }

  async get(projectId: string): Promise<SddState> {
    const project = this.project(projectId);
    const relDir = this.sddRelDir(project);
    const stored = this.store.get<SddState>('sdd_states', projectId);
    const [constDisk, specDisk, planDisk, tasksDisk] = await Promise.all([
      this.readDoc(project, relDir, 'constitution.md'),
      this.readDoc(project, relDir, 'spec.md'),
      this.readDoc(project, relDir, 'plan.md'),
      this.readDoc(project, relDir, 'tasks.md'),
    ]);
    if (stored) {
      const effectiveSpec = specDisk !== undefined ? specDisk : stored.specText;
      return {
        ...stored,
        sddRelDir: relDir,
        ...(constDisk !== undefined ? { constitutionText: constDisk } : {}),
        ...(specDisk !== undefined ? { specText: specDisk } : {}),
        specCriteria: extractSpecCriteria(effectiveSpec),
        ...(planDisk !== undefined ? { planText: planDisk } : {}),
        ...(tasksDisk !== undefined ? { tasksText: tasksDisk } : {}),
      };
    }
    const members = this.store.members();
    const defaultLead =
      project.meetingLeaderId ||
      members.find((m) => m.executor === 'claude')?.id ||
      members[0]?.id ||
      '';
    const defaultAdvisor =
      members.find((m) => m.id !== defaultLead && (m.executor.startsWith('acp-') || m.name.toLowerCase().includes('gemini')))?.id ||
      members.find((m) => m.id !== defaultLead)?.id;
    return {
      projectId,
      stage: tasksDisk ? 'tasks_ready' : planDisk ? 'plan_review' : specDisk ? 'spec_review' : 'idle',
      sddRelDir: relDir,
      requirement: '',
      leadMemberId: defaultLead,
      advisorMemberId: defaultAdvisor,
      constitutionText: constDisk,
      specText: specDisk,
      specCriteria: extractSpecCriteria(specDisk),
      planText: planDisk,
      tasksText: tasksDisk,
      updatedAt: now(),
    };
  }

  async saveConstitution(params: { projectId: string; constitutionText: string }): Promise<SddState> {
    const project = this.project(params.projectId);
    const relDir = this.sddRelDir(project);
    const constitutionText = String(params.constitutionText ?? '').trim();
    if (!constitutionText) throw new Error('宪法内容不能为空。');
    await this.writeDoc(project, relDir, 'constitution.md', constitutionText);
    const current = await this.get(project.id);
    return this.save({ ...current, sddRelDir: relDir, constitutionText, error: undefined });
  }

  async draftSpec(params: {
    projectId: string;
    requirement: string;
    leadMemberId: string;
    advisorMemberId?: string;
  }): Promise<SddState> {
    const project = this.project(params.projectId);
    const requirement = String(params.requirement ?? '').trim();
    if (!requirement) throw new Error('请先写下你的需求或目标。');
    const lead = this.member(params.leadMemberId);
    const advisorId = params.advisorMemberId && params.advisorMemberId !== lead.id ? params.advisorMemberId : undefined;
    if (this.activeOps.has(project.id)) throw new Error('当前项目正在生成 SDD 文档，请稍候。');

    const relDir = this.sddRelDir(project);
    const current = await this.get(project.id);
    const working = this.save({
      ...current,
      projectId: project.id,
      sddRelDir: relDir,
      stage: 'spec_drafting',
      requirement,
      leadMemberId: lead.id,
      advisorMemberId: advisorId,
      error: undefined,
    });

    this.activeOps.add(project.id);
    void (async () => {
      try {
        const prompt = [
          `你正在以主控（${lead.name}）身份为项目「${project.name}」（目录：${project.directory}）起草 SDD 需求规范（spec.md）。`,
          `【只读约束】只可只读查看项目现有文件，禁止修改任何代码或文件。`,
          current.constitutionText ? `【项目技术宪法（必须遵守）】\n${current.constitutionText}` : '',
          `【用户原始需求】\n${requirement}`,
          `【输出要求】直接输出一份清晰、克制、面向项目负责人的 Markdown 规范文档（不要包在 JSON 里），严格包含以下 4 节：`,
          `# 需求规范 (Spec)`,
          `## 1. 目标与背景`,
          `## 2. 非目标 (Out of Scope)`,
          `## 3. 核心约束与边界`,
          `## 4. 可验收标准 (Acceptance Criteria)（列出逐条可核验的检查项，用 - [ ] 列表，后续会自动提取为硬性验收清单）`,
          `若有查完代码仍定不了、且会改变方向的问题，放在末尾「## 5. 待确认问题」并附推荐项。`,
        ].filter(Boolean).join('\n\n');
        const res = await this.host.runIsolatedReadOnly(project.id, lead, 'SDD 起草 Spec', prompt);
        if (res.status !== 'done' || !res.text.trim()) {
          throw new Error(res.error || '起草 Spec 失败，请重试。');
        }
        const specText = res.text.trim();
        await this.writeDoc(project, relDir, 'spec.md', specText);
        const latest = this.store.get<SddState>('sdd_states', project.id) ?? working;
        this.save({ ...latest, stage: 'spec_review', specText, specCriteria: extractSpecCriteria(specText), error: undefined });
      } catch (err) {
        const latest = this.store.get<SddState>('sdd_states', project.id) ?? working;
        this.save({ ...latest, stage: latest.specText ? 'spec_review' : 'idle', error: (err as Error).message });
      } finally {
        this.activeOps.delete(project.id);
      }
    })();

    return working;
  }

  async saveSpec(params: { projectId: string; specText: string }): Promise<SddState> {
    const project = this.project(params.projectId);
    const relDir = this.sddRelDir(project);
    const specText = String(params.specText ?? '').trim();
    if (!specText) throw new Error('Spec 内容不能为空。');
    await this.writeDoc(project, relDir, 'spec.md', specText);
    const current = await this.get(project.id);
    return this.save({ ...current, sddRelDir: relDir, specText, stage: 'spec_review', error: undefined });
  }

  async startBlindProposals(params: {
    projectId: string;
    requirement?: string;
    leadMemberId: string;
    advisorMemberId?: string;
    specText?: string;
  }): Promise<SddState> {
    const project = this.project(params.projectId);
    if (this.activeOps.has(project.id)) throw new Error('当前项目正在运行双盲提案，请稍候。');
    const current = await this.get(project.id);
    const requirement = String(params.requirement ?? current.requirement ?? '').trim();
    const specText = String(params.specText ?? current.specText ?? '').trim() || undefined;
    if (!requirement && !specText) throw new Error('请先填写需求或 Spec。');

    const lead = this.member(params.leadMemberId || current.leadMemberId);
    const advisor =
      params.advisorMemberId && params.advisorMemberId !== lead.id
        ? this.member(params.advisorMemberId)
        : undefined;
    const relDir = this.sddRelDir(project);
    if (specText) await this.writeDoc(project, relDir, 'spec.md', specText);

    const startedAt = now();
    const initial = this.save({
      ...current,
      projectId: project.id,
      sddRelDir: relDir,
      stage: 'blind_proposing',
      requirement: requirement || current.requirement,
      specText,
      leadMemberId: lead.id,
      advisorMemberId: advisor?.id,
      leadProposal: {
        memberId: lead.id,
        memberName: lead.name,
        role: 'lead',
        status: 'running',
        startedAt,
      },
      advisorProposal: advisor
        ? {
            memberId: advisor.id,
            memberName: advisor.name,
            role: 'advisor',
            status: 'running',
            startedAt,
          }
        : undefined,
      error: undefined,
    });

    this.activeOps.add(project.id);
    void (async () => {
      try {
        const sharedContext = [
          `项目：「${project.name}」（目录：${project.directory}）`,
          current.constitutionText ? `【项目技术宪法（硬性约束，必须遵守）】\n${current.constitutionText}` : '',
          requirement ? `【用户原始需求】\n${requirement}` : '',
          specText ? `【已确认的 Spec 规范】\n${specText}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        const leadPrompt = [
          `你正在以主控（${lead.name}）身份进行【双盲独立提案】。`,
          `【只读约束】只读查看项目代码，不要修改任何文件。`,
          sharedContext,
          `【输出要求】直接输出一份独立的技术与实施方案（Markdown），包含：整体架构、模块与文件边界、接口契约、交互/体验要点、风险与验证方式。不要客套，直接给干货。`,
        ].join('\n\n');

        const advisorPrompt = advisor
          ? [
              `你正在以独立军师（${advisor.name}）身份进行【双盲独立提案】。你完全看不到主控的草稿，请完全从你的视角独立提出方案。`,
              `【只读约束】只读查看项目代码，不要修改任何文件。`,
              sharedContext,
              `【输出要求】直接输出一份独立方案（Markdown），重点覆盖：架构思路、交互与文案体验优化、容易遗漏的边界场景与风险。凡是未直接查证代码的推断，必须明确标注「【推测】」。`,
            ].join('\n\n')
          : '';

        const leadTask = this.host
          .runIsolatedReadOnly(project.id, lead, '双盲提案 · 主控独立方案', leadPrompt)
          .then((res) => {
            const st = this.store.get<SddState>('sdd_states', project.id) ?? initial;
            const ok = res.status === 'done' && Boolean(res.text.trim());
            this.save({
              ...st,
              leadProposal: {
                ...st.leadProposal!,
                status: ok ? 'done' : 'failed',
                text: ok ? res.text.trim() : undefined,
                error: ok ? undefined : res.error || '主控提案未完成',
                completedAt: now(),
              },
            });
            return { ok, text: res.text.trim(), error: res.error };
          });

        const advisorTask = advisor
          ? this.host
              .runIsolatedReadOnly(project.id, advisor, '双盲提案 · 军师独立方案', advisorPrompt)
              .then((res) => {
                const st = this.store.get<SddState>('sdd_states', project.id) ?? initial;
                const ok = res.status === 'done' && Boolean(res.text.trim());
                this.save({
                  ...st,
                  advisorProposal: {
                    ...st.advisorProposal!,
                    status: ok ? 'done' : 'failed',
                    text: ok ? res.text.trim() : undefined,
                    error: ok ? undefined : res.error || '军师提案未完成',
                    completedAt: now(),
                  },
                });
                return { ok, text: res.text.trim(), error: res.error };
              })
          : Promise.resolve(undefined);

        const [leadRes, advisorRes] = await Promise.all([leadTask, advisorTask]);
        if (!leadRes.ok && !advisorRes?.ok) {
          throw new Error(leadRes.error || advisorRes?.error || '双盲提案均未完成，请重试。');
        }

        const stBeforeSynth = this.store.get<SddState>('sdd_states', project.id) ?? initial;
        if (!advisor || !advisorRes?.ok) {
          const singlePlan = leadRes.text || advisorRes?.text || '';
          await this.writeDoc(project, relDir, 'plan.md', singlePlan);
          this.save({ ...stBeforeSynth, stage: 'plan_review', planText: singlePlan, error: undefined });
          return;
        }

        this.save({ ...stBeforeSynth, stage: 'synthesizing', error: undefined });
        const synthPrompt = [
          `你是主控（${lead.name}）。现在你和独立军师（${advisor.name}）已经各自盲出了一份方案。`,
          `【只读核实铁律】先核实 ${advisor.name} 方案中标注「【推测】」或与你冲突的判断（以项目真实代码和事实为准），再将两份方案合成一份最终供用户拍板的《双盲方案对照表与实施方案》（Markdown）。`,
          sharedContext,
          `=== 主控（${lead.name}）独立方案 ===\n${leadRes.text}`,
          `=== 军师（${advisor.name}）独立方案 ===\n${advisorRes.text}`,
          `【输出格式】严格包含以下 5 节，简洁直接、说人话：`,
          `# 双盲方案对照表与实施方案 (Plan)`,
          `## 1. 双方一致项`,
          `## 2. 采纳了 ${advisor.name} 的建议（及核实依据）`,
          `## 3. 未采纳项及理由`,
          `## 4. 待用户拍板的分歧（每条写清：要定什么、你的推荐项（标注「推荐：」）、各选项后果；若无分歧写「无」）`,
          `## 5. 最终合并实施方案（含模块划分、接口契约、验证方式与派工建议）`,
        ].join('\n\n');

        const synthRes = await this.host.runIsolatedReadOnly(project.id, lead, '双盲提案 · 合成对照表', synthPrompt);
        if (synthRes.status !== 'done' || !synthRes.text.trim()) {
          throw new Error(synthRes.error || '合成对照表失败，请重试。');
        }
        const planText = synthRes.text.trim();
        await this.writeDoc(project, relDir, 'plan.md', planText);
        const latest = this.store.get<SddState>('sdd_states', project.id) ?? stBeforeSynth;
        this.save({ ...latest, stage: 'plan_review', planText, error: undefined });
      } catch (err) {
        const latest = this.store.get<SddState>('sdd_states', project.id) ?? initial;
        this.save({
          ...latest,
          stage: latest.planText ? 'plan_review' : latest.specText ? 'spec_review' : 'idle',
          error: (err as Error).message,
        });
      } finally {
        this.activeOps.delete(project.id);
      }
    })();

    return initial;
  }

  async savePlan(params: { projectId: string; planText: string }): Promise<SddState> {
    const project = this.project(params.projectId);
    const relDir = this.sddRelDir(project);
    const planText = String(params.planText ?? '').trim();
    if (!planText) throw new Error('Plan 内容不能为空。');
    await this.writeDoc(project, relDir, 'plan.md', planText);
    const current = await this.get(project.id);
    return this.save({ ...current, sddRelDir: relDir, planText, stage: 'plan_review', error: undefined });
  }

  async approveAndLaunch(params: {
    projectId: string;
    userDecisionNote?: string;
    memberIds: string[];
    reviewLevel?: string;
  }): Promise<{ state: SddState; launched: boolean }> {
    const project = this.project(params.projectId);
    const current = await this.get(project.id);
    if (!current.planText && !current.specText) throw new Error('还没有可拍板的 Spec 或方案。');
    const relDir = this.sddRelDir(project);
    const decisionNote = String(params.userDecisionNote ?? '').trim();

    let finalPlan = current.planText ?? '';
    if (decisionNote && finalPlan) {
      finalPlan = `${finalPlan.trimEnd()}\n\n---\n\n## 用户拍板决定（${now()}）\n${decisionNote}\n`;
      await this.writeDoc(project, relDir, 'plan.md', finalPlan);
    }

    const specCriteria = extractSpecCriteria(current.specText);
    const tasksMd = [
      `# 任务清单 (Tasks)`,
      ``,
      ...(current.constitutionText ? [`- 项目宪法：\`${relDir}/constitution.md\``] : []),
      ...(current.specText ? [`- 需求规范：\`${relDir}/spec.md\``] : []),
      `- 已拍板方案：\`${relDir}/plan.md\``,
      `- 主控 Leader：${this.member(current.leadMemberId).name}`,
      ...(decisionNote ? [`- 用户拍板意见：${decisionNote}`] : []),
      ``,
      ...(specCriteria.length
        ? [
            `## Spec 强制验收标准（共 ${specCriteria.length} 条）`,
            ...specCriteria.map((c) => `- [ ] ${c}`),
            ``,
          ]
        : []),
      `## 执行任务（由 FountAIn 项目流程自动同步打勾）`,
      `> 正在拆解任务，拆解完成后将自动同步每条子任务状态。`,
    ].join('\n');
    await this.writeDoc(project, relDir, 'tasks.md', tasksMd);

    const updated = this.save({
      ...current,
      sddRelDir: relDir,
      specCriteria,
      planText: finalPlan || current.planText,
      tasksText: tasksMd,
      userDecisionNote: decisionNote || undefined,
      stage: 'tasks_ready',
      error: undefined,
    });

    const topicParts = [
      `【SDD + 双盲拍板立项】请严格依据已拍板的宪法、规范与方案拆解并执行本轮任务：`,
      current.constitutionText ? `- 项目技术宪法（必须遵守）：${relDir}/constitution.md` : '',
      current.specText ? `- 需求规范（唯一事实源）：${relDir}/spec.md` : '',
      finalPlan ? `- 已拍板双盲方案：${relDir}/plan.md` : '',
      `- 任务清单：${relDir}/tasks.md`,
      specCriteria.length
        ? `\n【Spec 强制验收标准（以下每一条都必须映射到对应任务的 check 验收标准中，不得遗漏）】\n${specCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
        : '',
      decisionNote ? `\n【用户拍板决定】\n${decisionNote}` : '',
      finalPlan ? `\n【方案摘要】\n${finalPlan.slice(0, 6000)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await this.host.startProjectFlow({
      projectId: project.id,
      leadMemberId: current.leadMemberId,
      memberIds: params.memberIds,
      reviewLevel: params.reviewLevel,
      topic: topicParts,
    });

    return { state: updated, launched: true };
  }

  /** Automatically sync real ProjectFlow tasks & completion checkmarks into tasks.md on disk. */
  async syncTasksFromFlow(projectId: string): Promise<void> {
    const stored = this.store.get<SddState>('sdd_states', projectId);
    if (!stored || stored.stage !== 'tasks_ready') return;
    const project = this.store.get<Project>('projects', projectId);
    if (!project) return;
    const flow = this.store
      .list<ProjectFlow>('project_flows')
      .filter((f) => f.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!flow) return;
    const tasks = this.store
      .list<Task>('flow_tasks')
      .filter((t) => t.flowId === flow.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!tasks.length) return;

    const relDir = this.sddRelDir(project);
    const members = new Map(this.store.members().map((m) => [m.id, m.name]));
    const statusLabels: Record<string, string> = {
      pending: '待开始',
      ready: '就绪',
      queued: '排队中',
      running: '执行中',
      awaiting_review: '待复核',
      reviewing: '复核中',
      correcting: '返工修正',
      review_passed: '已通过复核',
      accepted: '已验收',
      done: '已完成',
      blocked: '阻塞',
      escalated: '待你决定',
      cancelled: '已取消',
    };
    const isDone = (status: string) => ['review_passed', 'accepted', 'done'].includes(status);
    const doneCount = tasks.filter((t) => isDone(t.status)).length;
    const specCriteria = extractSpecCriteria(stored.specText);

    const lines = [
      `# 任务清单 (Tasks)`,
      ``,
      `- 同步时间：${now()}`,
      `- 进度：**${doneCount} / ${tasks.length}** 项已通过复核`,
      ...(stored.constitutionText ? [`- 项目宪法：\`${relDir}/constitution.md\``] : []),
      ...(stored.specText ? [`- 需求规范：\`${relDir}/spec.md\``] : []),
      `- 已拍板方案：\`${relDir}/plan.md\``,
      ...(stored.userDecisionNote ? [`- 用户拍板意见：${stored.userDecisionNote}`] : []),
      ``,
      `## 执行任务`,
      ...tasks.map((t) => {
        const mark = isDone(t.status) ? 'x' : ' ';
        const who = members.get(t.memberId) ?? t.memberId;
        const st = statusLabels[t.status] ?? t.status;
        const scope = t.allowedPaths?.length ? ` · 范围：\`${t.allowedPaths.join('`, `')}\`` : '';
        return `- [${mark}] **${t.title}**（${who} · ${st}${scope}）`;
      }),
      ...(specCriteria.length
        ? [
            ``,
            `## Spec 强制验收标准（共 ${specCriteria.length} 条）`,
            ...specCriteria.map((c) => `- [${doneCount === tasks.length ? 'x' : ' '}] ${c}`),
          ]
        : []),
    ];
    const tasksMd = lines.join('\n') + '\n';
    if (tasksMd === stored.tasksText) return;
    await this.writeDoc(project, relDir, 'tasks.md', tasksMd);
    this.store.put('sdd_states', projectId, { ...stored, tasksText: tasksMd, updatedAt: now() });
  }

  async reset(projectId: string): Promise<SddState> {
    const project = this.project(projectId);
    if (this.activeOps.has(project.id)) throw new Error('正在运行中，请等当前步骤结束再重置。');
    this.store.delete('sdd_states', project.id);
    this.host.changed();
    return this.get(project.id);
  }
}
