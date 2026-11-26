import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRuntimeDependencies} from './runtime-dependencies.mjs';
import {executableSignature} from './windows-signature.mjs';

function executableName(directory, platform = process.platform) {
  if (platform === 'win32' || existsSync(path.join(directory, 'FountAIn.exe'))) return 'FountAIn.exe';
  if (existsSync(path.join(directory, 'fountain'))) return 'fountain';
  if (existsSync(path.join(directory, 'FountAIn'))) return 'FountAIn';
  return 'fountain';
}

/** Written before installers are archived, so installed copies identify their actual source. */
export async function writeBuildManifest(directory,dependencies,platform=process.platform){
  const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const exe=executableName(directory,platform);
  const files=[exe,'resources/app/package.json','resources/app/package-lock.json'];
  async function collect(relative){for(const entry of await readdir(path.join(directory,relative),{withFileTypes:true})){const file=relative+'/'+entry.name;if(entry.isDirectory())await collect(file);else files.push(file);}}
  await collect('resources/app/dist');const hashes={};
  for(const file of files)hashes[file]=createHash('sha256').update(await readFile(path.join(directory,file))).digest('hex');
  const receipt={builtAt:new Date().toISOString(),platform,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8',windowsHide:true}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:workspace,encoding:'utf8',windowsHide:true}).trim(),deployment:'pending-installation',dependencies,hashes};
  if(platform==='win32')receipt.windowsSignature=executableSignature(path.join(directory,exe));
  await writeFile(path.join(directory,'build-manifest.json'),JSON.stringify(receipt,null,2));return receipt;
}

// Electron Builder calls this after editing executable icons/metadata, before archiving either target.
export default async function afterSign(context){
  const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.resolve(context.appOutDir);
  const platform=context.electronPlatformName;
  const allowed=platform==='win32'
    ?[path.join(workspace,'release','win-unpacked'),path.join(workspace,'release','win-arm64-unpacked')]
    :platform==='linux'
      ?[path.join(workspace,'release','linux-unpacked'),path.join(workspace,'release','linux-arm64-unpacked')]
      :[];
  if(!allowed.includes(output))throw new Error('Unexpected build manifest target: '+output);
  await writeBuildManifest(output,await verifyRuntimeDependencies(path.join(output,'resources/app')),platform);
}
