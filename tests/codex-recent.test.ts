import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractMaterialTerms } from '../src/backend/project-materials';
import { initializeStudyRoom } from '../src/backend/study-room';
import { workspaceProfileInstructions } from '../src/backend/workspace-profile';
import { parseDiscussionReply } from '../src/shared/discussion';
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
