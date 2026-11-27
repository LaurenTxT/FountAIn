import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDERER_METHODS } from '../src/shared/rpc-methods';
import { SDD_RPC_METHODS, extractSpecCriteria, resolveSddRelDir } from '../src/shared/sdd';
import { WORKSPACE_TOOLS_METHODS, formatDiffAnnotationsPrompt } from '../src/shared/workspace-tools';
import { applyCostModeToConfig, classifyCostTier } from '../src/shared/cost-mode';
import { roomNaturalMentions } from '../src/shared/room';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Guardrail: every room.* case in engine.ts is registered in RENDERER_METHODS', () => {
  const engineSrc = readFileSync(path.join(root, 'src', 'backend', 'engine.ts'), 'utf8');
  const allowlist = new Set(RENDERER_METHODS);
  const cases = [...engineSrc.matchAll(/case\s+["'](room\.[a-zA-Z0-9_.]+)["']\s*:/g)].map((m) => m[1]);
  assert.ok(cases.length > 10, 'Expected to find room.* RPC cases in engine.ts');
  const missing = [...new Set(cases)].filter((method) => !allowlist.has(method));
  assert.deepEqual(
    missing,
    [],
    `Engine room.* methods missing from RENDERER_METHODS (causes "不允许的工作台请求"): ${missing.join(', ')}`,
  );
});

test('Guardrail: review round-1 uses gpt-6.2-sol for Codex and escalates to gpt-6.2-astra on rework', () => {
  const base = {
    model: 'gpt-6.2-sol',
    effort: 'low' as const,
    modelSource: 'default' as const,
    effortSource: 'default' as const,
    capturedAt: '2026-11-27T00:00:00Z',
  };
  const round1 = applyCostModeToConfig(
    base,
    { executor: 'codex', costMode: 'economy' },
    classifyCostTier({ isCasualRoom: false, purpose: 'flow-review' }),
  );
  assert.equal(round1.model, 'gpt-6.2-sol');
  assert.equal(round1.effort, 'low');

  const round2 = applyCostModeToConfig(
    base,
    { executor: 'codex', costMode: 'economy' },
    classifyCostTier({ isCasualRoom: false, purpose: 'flow-review', isRetry: true }),
  );
  assert.equal(round2.model, 'gpt-6.2-astra');
  assert.equal(round2.effort, 'medium');
});

test('Guardrail: electron-builder Linux config and Ubuntu CI workflow stay valid', () => {
  const builderCfg = JSON.parse(readFileSync(path.join(root, 'electron-builder.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const ci = readFileSync(path.join(root, '.github', 'workflows', 'build-ubuntu.yml'), 'utf8');

  assert.ok(builderCfg.linux?.desktop?.entry?.Name, 'electron-builder v26 requires linux.desktop.entry.Name');
  assert.equal(builderCfg.linux?.desktop?.Name, undefined, 'linux.desktop.Name must be nested under linux.desktop.entry');
  assert.match(String(builderCfg.linux?.maintainer ?? ''), /<.+@.+>/, 'linux.maintainer must include email for deb');
  assert.ok(pkg.homepage, 'package.json must include homepage for deb');
  assert.match(ci, /node_modules\/electron\/install\.js/, 'Ubuntu CI must ensure electron binary is downloaded');
  assert.match(ci, /--publish never/, 'Ubuntu CI must pass --publish never');
});

test('Guardrail: roomNaturalMentions and model switching stay aligned', () => {
  const roster = [
    { id: 'm-claude', name: 'Claude', executor: 'claude' },
    { id: 'm-codex', name: 'ChatGPT', executor: 'codex' },
    { id: 'm-dsh', name: 'DeepSeek', executor: 'dsh' },
    { id: 'm-gem', name: 'Gemini', executor: 'acp-5d1dde7ed341' },
  ];
  assert.deepEqual(roomNaturalMentions('哈基米帮我看看交互文案', roster), ['m-gem']);
  assert.deepEqual(roomNaturalMentions('大肥鱼来核一下', roster), ['m-dsh']);
  assert.deepEqual(roomNaturalMentions('别用 astra，直接用 sol 跑', roster), []);
});

test('Guardrail: SDD RPC methods are all in RENDERER_METHODS and SDD dir/criteria helpers work', () => {
  const allowlist = new Set(RENDERER_METHODS);
  for (const method of SDD_RPC_METHODS) {
    assert.ok(allowlist.has(method), `SDD method ${method} missing from RENDERER_METHODS`);
  }
  assert.equal(resolveSddRelDir(true), '01_Drafts_and_Code/sdd');
  assert.equal(resolveSddRelDir(false), '.fountain/sdd');
  const criteria = extractSpecCriteria(`
# Spec
## 4. 可验收标准
- [ ] 支持导出 PDF 并保留目录
- [x] 不影响原有 Markdown 导出
- 普通列表不算验收项
  `);
  assert.deepEqual(criteria, ['支持导出 PDF 并保留目录', '不影响原有 Markdown 导出']);
});

test('Guardrail: Workspace Tools RPC methods are allowlisted and diff annotations format cleanly', () => {
  const allowlist = new Set(RENDERER_METHODS);
  for (const method of WORKSPACE_TOOLS_METHODS) {
    assert.ok(allowlist.has(method), `Workspace tool method ${method} missing from RENDERER_METHODS`);
  }
  const msg = formatDiffAnnotationsPrompt(
    [
      {
        id: '1',
        path: 'src/app.ts',
        line: 42,
        side: 'new',
        codeLine: 'const x = foo();',
        comment: '这里缺少空值兜底',
      },
    ],
    'Codex',
  );
  assert.match(msg, /@Codex/);
  assert.match(msg, /src\/app\.ts/);
  assert.match(msg, /第 42 行/);
  assert.match(msg, /这里缺少空值兜底/);
});
