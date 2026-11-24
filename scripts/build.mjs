import { rolldown } from 'rolldown';
import { build as buildVite } from 'vite';
import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import './build-job.mjs';

const external = (id) => !id.startsWith('.') && !id.startsWith('/') && !/^[a-zA-Z]:/.test(id);

async function bundleNode(input, file, format) {
  const b = await rolldown({ input, platform: 'node', external });
  await b.write({ file, format, sourcemap: true, codeSplitting: false });
  await b.close();
}

await mkdir('dist', { recursive: true });
for (const [entry, outfile, format] of [
  ['src/main/main.ts', 'dist/main.mjs', 'esm'],
  ['src/main/preload.ts', 'dist/preload.cjs', 'cjs'],
  ['src/backend/worker.ts', 'dist/worker.mjs', 'esm'],
  ['src/backend/adapters/claude-permission-mcp.ts', 'dist/claude-permission-mcp.cjs', 'cjs'],
]) {
  await bundleNode(entry, outfile, format);
}

if (existsSync('src/backend/backup.ts')) {
  await bundleNode('src/backend/backup.ts', 'dist/backup.mjs', 'esm');
} else {
  await Promise.all(['dist/backup.mjs', 'dist/backup.mjs.map'].map((file) => rm(file, { force: true })));
}

await copyFile('scripts/windows-job.ps1', 'dist/windows-job.ps1');
await copyFile('scripts/dsh-account-plugin.mjs', 'dist/dsh-account-plugin.mjs');
await copyFile('scripts/verify-runtime-dependencies.ps1', 'dist/verify-runtime-dependencies.ps1');
await copyFile('build/fountain.ico', 'dist/fountain.ico');
await copyFile('build/fountain.ico', 'dist/fountain-icon.ico');
await copyFile('build/fountain.ico', 'dist/fountain-icon-dark.ico');
await copyFile('build/fountain.png', 'dist/fountain.png');
await cp('build/third-party', 'dist/third-party', { recursive: true });
await buildVite({ base: './', build: { outDir: 'dist/renderer', emptyOutDir: true } });
console.log('FOUNTAIN_FULL_BUILD_OK');
