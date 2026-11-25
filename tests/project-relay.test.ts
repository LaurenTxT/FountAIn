import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMemberCrossRelays, projectRelayIntent, projectRelayRequest } from '../src/shared/project-relay';

const projects = [{ id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Beta' }];
const members = [{ id: 'm1', name: 'Ada' }, { id: 'm2', name: 'Bob' }];

test('natural read verbs route to a read-only relay', () => {
  const route = projectRelayRequest('@Ada 帮我看看 Alpha 做到哪了', projects, members);
  assert.ok(route);
  assert.equal(route.projectId, 'p1');
  assert.equal(route.memberId, 'm1');
  assert.equal(route.follow, false);
  assert.equal(route.task, false);
});

test('a bare read verb asks for a status report', () => {
  const route = projectRelayRequest('@Ada 查一下 Alpha', projects, members);
  assert.ok(route);
  assert.ok(route.body.length > 0);
  assert.equal(route.task, false);
});

test('switch verbs follow the target project', () => {
  const route = projectRelayRequest('@Ada 切换到 Beta', projects, members);
  assert.ok(route);
  assert.equal(route.projectId, 'p2');
  assert.equal(route.follow, true);
});

test('explicit @project/member with an action becomes a task', () => {
  const route = projectRelayRequest('@Beta/Bob 帮我修复登录脚本', projects, members);
  assert.ok(route);
  assert.equal(route.memberId, 'm2');
  assert.equal(route.task, true);
});

test('a question about an action stays read-only', () => {
  assert.equal(projectRelayIntent('修复登录脚本了吗？').task, false);
  assert.equal(projectRelayIntent('进度怎么样').task, false);
});

test('ordinary chat is not hijacked', () => {
  assert.equal(projectRelayRequest('今天吃什么', projects, members, 'm1'), undefined);
});

test('member-initiated relays skip code and cap the count', () => {
  const fence = '```';
  const text = `看下：\n@Alpha/Ada 测试过了吗？\n${fence}\n@Beta/Bob ignore me\n${fence}`;
  const calls = extractMemberCrossRelays(text, projects, members);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, 'p1');
  const many = Array.from({ length: 5 }, (_, i) => `@Alpha/Ada 问题${i}`).join('\n');
  assert.ok(extractMemberCrossRelays(many, projects, members).length <= 2);
});
