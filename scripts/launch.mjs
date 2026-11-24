import { spawn } from 'node:child_process';
import electron from 'electron';
import { fileURLToPath } from 'node:url';
import { developmentRuntime } from './development-runtime.mjs';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electronPath =
  typeof electron === 'string'
    ? electron
    : fileURLToPath(new URL(`../node_modules/electron/dist/electron${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const executable = await developmentRuntime(electronPath);
const root = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(executable, [root], { cwd: root, env, stdio: 'inherit', windowsHide: true });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
