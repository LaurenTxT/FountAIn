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
});
