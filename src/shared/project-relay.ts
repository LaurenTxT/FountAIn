type ProjectTarget = { id: string; name: string };
type MemberTarget = { id: string; name: string };

export type ProjectRelayTarget = { projectId: string; memberId: string };
export type ProjectRelayRequest = ProjectRelayTarget & { body: string; follow: boolean; task: boolean };

const byLength = (a: { name: string }, b: { name: string }) => b.name.length - a.name.length;

export function projectRelayRequest(text: string, projects: ProjectTarget[], members: MemberTarget[], fallback?: string): ProjectRelayRequest | undefined {
  const command = text.trim().replace(/^＠/, '@');
  function exactProject(name: string) {
    if (new Set(projects.filter(item => item.name.toLowerCase() === name.toLowerCase()).map(item => item.id)).size > 1)
      throw new Error('有多个同名项目，请用「父项目 / 子项目」指定。');
  }
  for (const project of [...projects].sort(byLength)) {
    const name = project.name.toLowerCase();
    const direct = command.slice(1, name.length + 2).toLowerCase() === name + '/';
    if (command.startsWith('@') && direct) {
      exactProject(project.name);
      const tail = command.slice(name.length + 2);
      const member = [...members].sort(byLength).find(item =>
        tail.slice(0, item.name.length).toLowerCase() === item.name.toLowerCase() &&
        /^[\s：:，,]|^$/.test(tail.slice(item.name.length)),
      );
      if (!member) throw new Error('请在 @项目/成员 中填写目标成员名称。');
      return build(project.id, member.id, tail.slice(member.name.length), false, false);
    }
  }
  const addressed = [...members].sort(byLength).find(member =>
    command.slice(0, member.name.length + 1).toLowerCase() === '@' + member.name.toLowerCase() &&
    /^[\s：:，,]|^$/.test(command.slice(member.name.length + 1)),
  );
  const memberId = addressed?.id ?? fallback;
  if (!memberId || command.startsWith('@') && !addressed) return undefined;
  const instruction = command.slice(addressed ? addressed.name.length + 1 : 0).replace(/^[\s：:，,]+/, '');
  const verb = instruction.match(
    /^(?:请\s*)?(?:帮我\s*)?(切换到|切到|转到|切回|(?:去|到)?(?:看一下|看下|看看|查看|查一下|查下|查|问一下|问下|问问)|去|到)\s*/,
  );
  if (!verb) return undefined;
  const action = verb[1];
  const isSwitch = /^(?:切换到|切到|转到|切回)$/.test(action);
  const isReadVerb = /(?:看|查|问)/.test(action);
  const tail = instruction.slice(verb[0].length);
  for (const project of [...projects].sort(byLength)) {
    if (tail.slice(0, project.name.length).toLowerCase() !== project.name.toLowerCase()) continue;
    const body = tail.slice(project.name.length);
    if (/^[a-z0-9_-]/i.test(body)) continue;
    exactProject(project.name);
    return build(project.id, memberId, body, isSwitch, isReadVerb);
  }
}

function build(projectId: string, memberId: string, text: string, switchProject: boolean, isReadVerb: boolean): ProjectRelayRequest {
  const cleaned = text.replace(/^[\s：:，,]+/, '');
  const follow = switchProject || /^继续聊(?:[\s：:，,]|$)/.test(cleaned);
  let question = cleaned.replace(/^继续聊[\s：:，,]*/, '');
  if (!question && isReadVerb && !follow) {
    question = '请简明汇报当前项目的最新进度、当前状态和待处理事项。';
  }
  return { projectId, memberId, follow, ...projectRelayIntent(question) };
}

export function projectRelayIntent(question: string) {
  const command = /^(?:交办|安排任务|委派|委托|让(?:他|她|它)?去?执行|执行)(?:[\s：:，,]+|$)/;
  if (command.test(question)) return { task: true, body: question.replace(command, '').trim() };
  const perform = /^(?:请\s*|帮我\s*|去\s*)?(?:复核一下|独立复核|补跑|重跑|重做|修复|修改|改一下|改下|写一下|跑一下|运行|提交|构建|打包|更新|清理|整理|动手)/.test(question);
  const inquiry = /[?？]|(?:怎么|是否|什么|了吗|了没|没有|做到哪|进度|情况|进展)(?:[。！!]?$)/.test(question);
  return { task: perform && !inquiry, body: question };
}

export function extractMemberCrossRelays(
  text: string,
  projects: ProjectTarget[],
  members: MemberTarget[],
  limit = 2,
): { projectId: string; memberId: string; body: string }[] {
  // Strip fenced code blocks and inline code so examples never trigger cross-room relays.
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const sortedProjects = [...projects].sort(byLength);
  const sortedMembers = [...members].sort(byLength);
  const results: { projectId: string; memberId: string; body: string }[] = [];
  const seen = new Set<string>();

  for (const rawLine of stripped.split(/\r?\n/)) {
    if (results.length >= limit) break;
    const line = rawLine.trim();
    if (!line || !/[@＠]/.test(line)) continue;
    let idx = 0;
    while (idx < line.length && results.length < limit) {
      const at = line.slice(idx).search(/[@＠]/);
      if (at < 0) break;
      const pos = idx + at;
      const slice = line.slice(pos + 1);
      let matched = false;
      for (const project of sortedProjects) {
        const pname = project.name.toLowerCase();
        if (slice.slice(0, pname.length + 1).toLowerCase() !== pname + '/') continue;
        if (new Set(projects.filter(p => p.name.toLowerCase() === pname).map(p => p.id)).size > 1) continue;
        const afterSlash = slice.slice(pname.length + 1);
        const member = sortedMembers.find(m =>
          afterSlash.slice(0, m.name.length).toLowerCase() === m.name.toLowerCase() &&
          /^[\s：:，,]|^$/.test(afterSlash.slice(m.name.length)),
        );
        if (!member) continue;
        const body = afterSlash.slice(member.name.length).replace(/^[\s：:，,]+/, '').trim();
        const dedupeKey = `${project.id}:${member.id}`;
        if (body && !seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          results.push({ projectId: project.id, memberId: member.id, body });
        }
        idx = pos + 1 + pname.length + 1 + member.name.length;
        matched = true;
        break;
      }
      if (!matched) idx = pos + 1;
    }
  }
  return results;
}
