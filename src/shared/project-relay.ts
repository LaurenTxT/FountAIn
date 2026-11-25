type ProjectTarget = { id: string; name: string };
type MemberTarget = { id: string; name: string };

export type ProjectRelayTarget = { projectId: string; memberId: string };
export type ProjectRelayRequest = ProjectRelayTarget & { body: string; follow: boolean; task: boolean };

export function projectRelayRequest(text: string, projects: ProjectTarget[], members: MemberTarget[], fallback?: string): ProjectRelayRequest | undefined {
  const command = text.trim().replace(/^＠/, '@');
  function exactProject(name: string) {
    if (new Set(projects.filter(item => item.name.toLowerCase() === name.toLowerCase()).map(item => item.id)).size > 1)
      throw new Error('有多个同名项目，请用「父项目 / 子项目」指定。');
  }
  const byLength = (a: { name: string }, b: { name: string }) => b.name.length - a.name.length;
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
      return build(project.id, member.id, tail.slice(member.name.length), false);
    }
  }
  const addressed = [...members].sort(byLength).find(member =>
    command.slice(0, member.name.length + 1).toLowerCase() === '@' + member.name.toLowerCase() &&
    /^[\s：:，,]|^$/.test(command.slice(member.name.length + 1)),
  );
  const memberId = addressed?.id ?? fallback;
  if (!memberId || command.startsWith('@') && !addressed) return undefined;
  const instruction = command.slice(addressed ? addressed.name.length + 1 : 0).replace(/^[\s：:，,]+/, '');
  const verb = instruction.match(/^(帮我\s*)?(切换到|切到|转到|去|到)\s*/);
  if (!verb) return undefined;
  const tail = instruction.slice(verb[0].length);
  for (const project of [...projects].sort(byLength)) {
    if (tail.slice(0, project.name.length).toLowerCase() !== project.name.toLowerCase()) continue;
    const body = tail.slice(project.name.length);
    if (/^[a-z0-9_-]/i.test(body)) continue;
    exactProject(project.name);
    return build(project.id, memberId, body, /切|转/.test(verb[2]));
  }
}

function build(projectId: string, memberId: string, text: string, switchProject: boolean): ProjectRelayRequest {
  const body = text.replace(/^[\s：:，,]+/, '');
  const follow = switchProject || /^继续聊(?:[\s：:，,]|$)/.test(body);
  const question = body.replace(/^继续聊[\s：:，,]*/, '');
  return { projectId, memberId, follow, ...projectRelayIntent(question) };
}

export function projectRelayIntent(question: string) {
  const command = /^(?:交办|安排任务)(?:[\s：:，,]+|$)/;
  if (command.test(question)) return { task: true, body: question.replace(command, '').trim() };
  const perform = /^(?:请\s*|帮我\s*)?(?:复核一下|独立复核|补跑|重跑|重做|修复)/.test(question);
  const inquiry = /[?？]|(?:怎么|是否|什么|了吗|了没|没有)(?:[。！!]?$)/.test(question);
  return { task: perform && !inquiry, body: question };
}
