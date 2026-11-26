import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractMaterialTerms } from '../src/backend/project-materials';
import { initializeStudyRoom } from '../src/backend/study-room';
import { workspaceProfileInstructions } from '../src/backend/workspace-profile';
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
