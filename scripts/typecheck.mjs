import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ext = process.platform === 'win32' ? '.exe' : '';
const nativeTsc = path.join(root, 'node_modules', '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', `tsc${ext}`);
const cliJs = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const res = existsSync(nativeTsc)
  ? spawnSync(nativeTsc, ['--noEmit'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true })
  : spawnSync(process.execPath, [cliJs, '--noEmit'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
process.exit(res.status ?? 1);
