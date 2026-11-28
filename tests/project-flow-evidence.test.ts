import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFlowEvidence } from '../src/backend/project-flow-evidence';
import { commandEvidenceProblem } from '../src/shared/project-flow-review';
import type { Evidence } from '../src/shared/project-flow';
import type { TimelineEvent } from '../src/shared/types';

const header = "python -I - <<'EOF'";
function invocation(id: string, output: string, exitCode = 0): TimelineEvent[] {
  const base = { runId: 'review', sessionId: 'session', provider: 'claude', kind: 'tool', fidelity: 'native', at: '', text: '' } as const;
  return [
    { ...base, id: id + '-start', data: { id, type: 'tool_use', input: { command: header + "\nopen('" + output + "', 'w')\nEOF" } } },
    { ...base, id: id + '-end', data: { tool_use_id: id, type: 'tool_result', exitCode } },
  ];
}
const evidence = (command: string, eventIds: string[] = []): Evidence =>
  ({ kind: 'command', command, description: 'link check', result: 'done', exitCode: 0, eventIds, source: 'reported' });

test('review binds summarized scripts to uniquely identified native completion events', () => {
  const events = [...invocation('a', 'report2.txt'), ...invocation('b', 'report3.txt')];
  const results = bindFlowEvidence([
    evidence(header + ' （输出 report2.txt）'),
    evidence(header + ' (输出 report3.txt)'),
    evidence(header, ['b-end']),
    evidence(header),
  ], events, ['review']);
  assert.deepEqual(results.map(result => result.eventIds), [['a-end'], ['b-end'], ['b-end'], []]);
  assert.equal(results[3].source, 'reported');
  assert.equal(bindFlowEvidence([evidence(header, ['a-end'])], events, ['another-run'])[0].source, 'reported');
});

test('ambiguous, unfinished and failed executions cannot pass a summarized command check', () => {
  const claim = evidence(header + ' （输出 report.txt）');
  assert.equal(bindFlowEvidence([claim], [...invocation('a', 'report.txt'), ...invocation('b', 'report.txt')], ['review'])[0].source, 'reported');
  assert.equal(bindFlowEvidence([claim], invocation('a', 'report.txt').slice(0, 1), ['review'])[0].source, 'reported');
  const failed = bindFlowEvidence([claim], invocation('a', 'report.txt', 1), ['review'])[0];
  assert.equal(commandEvidenceProblem(failed), 'exit-code-mismatch');
});


test('script evidence can refer to the final command of a native tool call', () => {
  const [start, done] = invocation('a', 'report.txt');
  const command = `cd "$TEMP" && cat > check.py <<'EOF'\nprint("ok")\nEOF\npython -I check.py`;
  const native = { ...start, data: { id: 'a', type: 'tool_use', input: { command } } };
  const claim = evidence('python -I check.py（脚本：检查链接）');
  const linked = bindFlowEvidence([claim], [native, done], ['review'])[0];
  assert.deepEqual(linked.eventIds, ['a-end']);
  assert.equal(commandEvidenceProblem(linked), undefined);
  assert.equal(bindFlowEvidence([claim], [native], ['review'])[0].source, 'reported');
  assert.equal(bindFlowEvidence([evidence('python -I other.py（脚本：检查链接）')], [native, done], ['review'])[0].source, 'reported');
});
