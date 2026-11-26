import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractMaterialTerms } from '../src/backend/project-materials';
import { initializeStudyRoom } from '../src/backend/study-room';
import { workspaceProfileInstructions } from '../src/backend/workspace-profile';
import { parseDiscussionReply } from '../src/shared/discussion';
import { applyCostModeToConfig, classifyCostTier, resolveEconomyModel } from '../src/shared/cost-mode';
import { roomNaturalMentions } from '../src/shared/room';
import { productionPackages } from '../scripts/runtime-dependencies.mjs';
import type { Project } from '../src/shared/types';

test('extractMaterialTerms splits natural Chinese sentences into searchable terms', () => {
  const terms = extractMaterialTerms('帮我把机器学习导论的期中作业说明和评分标准找出来');
  assert.ok(terms.includes('机器学习导论') || terms.includes('机器'));
  assert.ok(terms.includes('期中作业说明') || terms.includes('期中'));
  assert.ok(terms.includes('评分标准') || terms.includes('评分'));
  const mixed = extractMaterialTerms('看看 CS101 的 Lab2 rubric');
  assert.ok(mixed.includes('cs101'));
  assert.ok(mixed.includes('lab2'));
  assert.ok(mixed.includes('rubric'));
});

test('initializeStudyRoom creates structured directories and documents idempotently', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fountain-study-room-')));
  try {
    initializeStudyRoom(dir, 'Demo Task');
    for (const sub of ['00_Context_and_Specs', '01_Drafts_and_Code', '02_Reviews_and_Debug', '03_Final_Submissions']) {
      assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), `${sub} should exist`);
    }
    assert.ok(fs.readFileSync(path.join(dir, 'ROOM_BRIEF.md'), 'utf8').includes('Demo Task'));
    assert.ok(fs.existsSync(path.join(dir, 'HANDOFF.md')));
    assert.ok(fs.existsSync(path.join(dir, '02_Reviews_and_Debug', 'DISCUSSION.md')));

    // Existing custom content must not be overwritten on repair/re-init.
    fs.writeFileSync(path.join(dir, 'ROOM_BRIEF.md'), '# Custom Brief\n', 'utf8');
    initializeStudyRoom(dir, 'Demo Task');
    assert.equal(fs.readFileSync(path.join(dir, 'ROOM_BRIEF.md'), 'utf8'), '# Custom Brief\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workspaceProfileInstructions walks up ancestor folders and gates studentId', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fountain-profile-'));
  try {
    const nested = path.join(root, 'Courses', 'TaskA');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      [
        '## 用户资料与时间估计（全局）',
        '- **姓名**：张三',
        '- **学号**：1000001',
        '- **专业**：Computer Science',
        '',
        '**先给 Timeline，再出方案或开工。**',
      ].join('\n'),
      'utf8',
    );
    const projects: Project[] = [
      { id: 'p1', name: 'TaskA', directory: nested, createdAt: new Date().toISOString() } as Project,
    ];
    const normal = workspaceProfileInstructions(projects, 'p1', '今天先看看架构');
    assert.ok(normal.includes('张三'));
    assert.ok(normal.includes('Timeline'));
    assert.ok(!normal.includes('1000001'), 'studentId must stay omitted unless explicitly requested');

    const explicit = workspaceProfileInstructions(projects, 'p1', '作业封面要填一下我的学号');
    assert.ok(explicit.includes('1000001'), 'studentId should appear when explicitly requested');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseDiscussionReply parses proposeKickoff safely and rejects mismatched turns', () => {
  const okObj = parseDiscussionReply(
    JSON.stringify({
      version: 1,
      turn: 't1',
      revision: 3,
      action: 'speak',
      body: '这个任务较复杂，我来牵头立项起草方案。',
      proposeKickoff: { topic: '  实现模块 A 与联调  ', reason: '熟悉整体架构' },
    }),
    't1',
    3,
  );
  assert.deepEqual(okObj.proposeKickoff, { topic: '实现模块 A 与联调', reason: '熟悉整体架构' });

  const okStr = parseDiscussionReply(
    JSON.stringify({
      version: 1,
      turn: 't2',
      revision: 1,
      action: 'speak',
      body: '我来立项。',
      proposeKickoff: '重构数据管线',
    }),
    't2',
    1,
  );
  assert.deepEqual(okStr.proposeKickoff, { topic: '重构数据管线' });

  const stale = parseDiscussionReply(
    JSON.stringify({
      version: 1,
      turn: 'wrong-turn',
      revision: 1,
      action: 'speak',
      body: '旧轮次',
      proposeKickoff: { topic: '不应触发' },
    }),
    't3',
    1,
  );
  assert.equal(stale.proposeKickoff, undefined);
  assert.ok(stale.formatWarnings?.some((w) => w.includes('立项提议')));

  const nonSpeak = parseDiscussionReply(
    JSON.stringify({
      version: 1,
      turn: 't4',
      revision: 1,
      action: 'ask_user',
      body: '要先确认吗？',
      questions: [{ to: 'user', text: '是否开始？' }],
      proposeKickoff: { topic: '不应在 ask_user 触发' },
    }),
    't4',
    1,
  );
  assert.equal(nonSpeak.proposeKickoff, undefined);
});

test('productionPackages resolves runtime dependencies for both linux and win32', () => {
  const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'));
  const linuxPkgs = new Map(productionPackages(lock, 'linux', 'x64'));
  const winPkgs = new Map(productionPackages(lock, 'win32', 'x64'));
  assert.ok(linuxPkgs.has('node_modules/7zip-bin'));
  assert.ok(linuxPkgs.has('node_modules/undici'));
  assert.ok(winPkgs.has('node_modules/7zip-bin'));
});

test('costMode downgrades models in casual rooms and keeps full power for project tasks', () => {
  assert.equal(resolveEconomyModel('claude', 'opus'), 'sonnet');
  assert.equal(resolveEconomyModel('claude', 'fable'), 'sonnet');
  assert.equal(resolveEconomyModel('claude', 'claude-fable'), 'sonnet');
  assert.equal(resolveEconomyModel('acp-gemini', 'Gemini 4 Carbon'), 'Gemini 4 Neon');
  assert.equal(resolveEconomyModel('acp-gemini', 'gemini-4-carbon'), 'gemini-4-neon');
  assert.equal(resolveEconomyModel('codex', 'gpt-6.2-astra'), 'gpt-6.2-sol');
  assert.equal(resolveEconomyModel('codex', 'GPT 6.2 Astra'), 'GPT 6.2 Sol');
  assert.equal(resolveEconomyModel('dsh', 'deepseek-v4-pro'), 'deepseek-flash');
  assert.equal(resolveEconomyModel('acp-gemini', 'gemini-3-pro'), 'gemini-3-flash');
  assert.equal(resolveEconomyModel('acp-custom', 'carbon-pro', 'custom-lite'), 'custom-lite');

  const base = { model: 'opus', effort: 'high' as const, modelSource: 'default' as const, effortSource: 'default' as const, capturedAt: '2026-11-26T00:00:00Z' };
  const casual = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: '今天吃啥' }));
  assert.equal(casual.model, 'sonnet');
  assert.equal(casual.effort, 'low');

  const eng = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ purpose: 'flow-task', flowId: 'f1', isCasualRoom: false }));
  assert.equal(eng.model, 'opus');
  assert.equal(eng.effort, 'low');

  const engCodex = applyCostModeToConfig({ ...base, model: 'gpt-6.2-astra' }, { executor: 'codex', costMode: 'economy' }, classifyCostTier({ purpose: 'flow-task', flowId: 'f1', isCasualRoom: false }));
  assert.equal(engCodex.model, 'gpt-6.2-sol');

  const review = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ purpose: 'flow-review', flowId: 'f1', isCasualRoom: false }));
  assert.equal(review.model, 'fable');
  assert.equal(review.effort, 'low');

  const retry = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ purpose: 'flow-task', flowId: 'f1', isCasualRoom: false, isRetry: true }));
  assert.equal(retry.model, 'opus');
  assert.equal(retry.effort, 'medium');

  const keywordBump = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: '帮忙深度复核捉虫一下这段架构' }));
  assert.equal(keywordBump.model, 'opus');
  assert.equal(keywordBump.effort, 'low');

  const keywordBumpDsh = applyCostModeToConfig({ ...base, model: 'deepseek-v4-pro' }, { executor: 'dsh', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: '帮忙捉虫一下' }));
  assert.equal(keywordBumpDsh.model, 'deepseek-flash');

  const mentionBump = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ purpose: 'room-mention', isCasualRoom: true, promptText: '看看这个' }));
  assert.equal(mentionBump.model, 'opus');

  const tracebackBump = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: 'Traceback (most recent call last):\nTypeError: x' }));
  assert.equal(tracebackBump.model, 'opus');

  const meetingClaude = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, isMeeting: true, promptText: '开会讨论' }));
  assert.equal(meetingClaude.model, 'opus');
  const meetingDsh = applyCostModeToConfig({ ...base, model: 'deepseek-v4-pro' }, { executor: 'dsh', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, isMeeting: true, promptText: '开会讨论' }));
  assert.equal(meetingDsh.model, 'deepseek-flash');
  assert.equal(meetingDsh.effort, 'low');
  const meetingCodex = applyCostModeToConfig({ ...base, model: 'gpt-6.2-astra' }, { executor: 'codex', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, isMeeting: true, promptText: '开会讨论' }));
  assert.equal(meetingCodex.model, 'gpt-6.2-sol');
  const meetingGemini = applyCostModeToConfig({ ...base, model: 'gemini-4-carbon' }, { executor: 'acp-5d1dde7ed341', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, isMeeting: true, promptText: '开会讨论' }));
  assert.equal(meetingGemini.model, 'gemini-4-neon');
});

test('roomNaturalMentions resolves names without @ while ignoring model IDs and code', () => {
  const roster = [
    { id: 'm-claude', name: 'Claude', executor: 'claude' },
    { id: 'm-codex', name: 'ChatGPT', executor: 'codex' },
    { id: 'm-dsh', name: 'DeepSeek', executor: 'dsh' },
    { id: 'm-gem', name: 'Gemini', executor: 'acp-gemini' },
  ];
  assert.deepEqual(roomNaturalMentions('Claude 帮我看看这段代码', roster), ['m-claude']);
  assert.deepEqual(roomNaturalMentions('让 DeepSeek 和 GPT 评一下', roster), ['m-dsh', 'm-codex']);
  assert.deepEqual(roomNaturalMentions('问问小克这个架构行不行', roster), ['m-claude']);
  assert.deepEqual(roomNaturalMentions('大肥鱼你觉得呢', roster), ['m-dsh']);
  assert.deepEqual(roomNaturalMentions('哈基米帮我看看', roster), ['m-gem']);
  assert.deepEqual(roomNaturalMentions('碳基米和氢基米来评一下', roster), ['m-gem']);
  assert.deepEqual(roomNaturalMentions('氖基米说说看法', roster), ['m-gem']);
  assert.deepEqual(roomNaturalMentions('今天用 gpt-6.2-sol 和 deepseek-flash 跑的', roster), []);
  assert.deepEqual(roomNaturalMentions('看下 `claude.exe` 的日志', roster), []);
});

test('natural language model switching overrides tier routing cleanly', () => {
  const base = { model: 'opus', effort: 'low' as const, modelSource: 'default' as const, effortSource: 'default' as const, capturedAt: '2026-11-27T00:00:00Z' };
  const carbon = applyCostModeToConfig({ ...base, model: 'gemini-4-neon' }, { executor: 'acp-5d1dde7ed341', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: '碳基米帮我看看这段' }));
  assert.equal(carbon.model, 'gemini-4-carbon-low');
  assert.equal(carbon.effort, undefined);

  const hydrogen = applyCostModeToConfig({ ...base, model: 'gemini-4-neon' }, { executor: 'acp-5d1dde7ed341', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: '让氢基米高思考算一下' }));
  assert.equal(hydrogen.model, 'gemini-4-hydrogen-high');
  assert.equal(hydrogen.effort, undefined);

  const neon = applyCostModeToConfig({ ...base, model: 'gemini-4-carbon' }, { executor: 'acp-5d1dde7ed341', costMode: 'normal' }, classifyCostTier({ isCasualRoom: true, promptText: '氖基米来说两句' }));
  assert.equal(neon.model, 'gemini-4-neon');

  const fable = applyCostModeToConfig(base, { executor: 'claude', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: 'Claude 用 fable 写一个方案' }));
  assert.equal(fable.model, 'fable');

  const astra = applyCostModeToConfig({ ...base, model: 'gpt-6.2-sol' }, { executor: 'codex', costMode: 'economy' }, classifyCostTier({ isCasualRoom: true, promptText: 'GPT 换 astra 看看' }));
  assert.equal(astra.model, 'gpt-6.2-astra');
});
