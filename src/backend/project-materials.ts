import { randomUUID } from 'node:crypto';
import { constants, readdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/types';
import type { Store } from './store';
import { resolveSafePath } from './security';
import { folderPath } from './folder-path';
import { directoriesOverlap, withProjectWrite } from './project-access';

import { PROJECT_CONTEXT_DIRECTORY } from '../shared/project-tree';

function relativeInside(root: string, candidate: string): string | undefined {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? relative : undefined;
}

export async function copyProjectMaterials(store: Store, projectId: string, files: unknown, currentTurn?: () => boolean) {
  const project = store.get<Project>('projects', projectId);
  const parent = project?.parentId ? store.get<Project>('projects', project.parentId) : undefined;
  if (!project || project.kind || !parent || parent.kind) throw new Error('请在有独立文件夹的子项目中导入资料。');
  if (!Array.isArray(files) || !files.length || files.length > 100 || files.some(file => typeof file !== 'string'))
    throw new Error('请选择 1 到 100 个资料文件。');
  const sourceRoot = await fs.realpath(parent.directory);
  const root = await fs.realpath(project.directory);
  if (directoriesOverlap(sourceRoot, root) && !relativeInside(sourceRoot, root))
    throw new Error('子项目需要使用独立工作文件夹，才能保存专属资料。');

  return withProjectWrite(store, projectId, project.directory, async checkScope => {
    const check = () => {
      checkScope();
      if(currentTurn && !currentTurn())throw new Error('会议已更新，本轮取件已撤回。');
    };
    check();
    const current = store.get<Project>('projects', projectId);
    if (current?.parentId !== parent.id || store.get<Project>('projects', parent.id)?.directory !== parent.directory)
      throw new Error('项目归属已变更，请重新选择资料。');
    const rooms = store.list<Project>('projects').filter(item => !item.kind && item.id !== parent.id)
      .map(item => folderPath(item.directory).directory).filter(folder => relativeInside(sourceRoot, folder));
    const pending = new Map<string, { source: string; relative: string; target: string }>();
    for (const input of files as string[]) {
      if (!path.isAbsolute(input)) throw new Error('请选择大项目文件夹内的资料。');
      const fromParent = relativeInside(parent.directory, input) ?? relativeInside(sourceRoot, input);
      if (!fromParent || fromParent.split(path.sep).some(part => part.startsWith('.')))
        throw new Error('资料必须位于大项目的普通资料目录内。');
      const source = await fs.realpath(resolveSafePath(sourceRoot, fromParent));
      const relative = relativeInside(sourceRoot, source);
      if (!relative || relative.split(path.sep).some(part => part.startsWith('.')) ||
        currentTurn && !automaticSource(relative.replaceAll('\\', '/')) ||
        rooms.some(folder => relativeInside(folder, source)) || !(await fs.stat(source)).isFile())
        throw new Error('请选择大项目中的资料文件。其他讨论室的工作文件不能作为共享资料导入。');
      const target = path.join(PROJECT_CONTEXT_DIRECTORY, relative);
      resolveSafePath(root, target);
      pending.set(process.platform === 'win32' ? target.toLowerCase() : target, { source, relative, target });
    }
    const copied: string[] = [], existing: string[] = [], created: string[] = [];
    try {
      for (const item of pending.values()) {
        check();
        const target = resolveSafePath(root, item.target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (path.relative(path.dirname(target), await fs.realpath(path.dirname(target))) !== '')
          throw new Error('资料存放目录包含重定向，请使用普通文件夹。');
        const temp = path.join(path.dirname(target), '.fountain-copy-' + randomUUID());
        try {
          await fs.copyFile(item.source, temp, constants.COPYFILE_EXCL);
          check();
          try {
            await fs.link(temp, target);
            created.push(target);
            copied.push(item.relative.replaceAll('\\', '/'));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.lstat(target)).isFile()) throw error;
            existing.push(item.relative.replaceAll('\\', '/'));
          }
        } finally { await fs.unlink(temp).catch(() => {}); }
      }
    } catch (error) {
      await Promise.all(created.map(target => fs.unlink(target).catch(() => {})));
      throw error;
    }
    return { copied, existing };
  }, true, [PROJECT_CONTEXT_DIRECTORY]);
}
const MATERIAL_FILE = /\.(?:pdf|docx?|pptx?|xlsx?|ods|odt|odp|md|txt|rtf|csv|tsv|jsonl?|ya?ml|parquet|ipynb|py|r|sql|png|jpe?g|webp|svg|mp4|mov|wav|mp3|srt|vtt|zip)$/i;
const MATERIAL_IGNORE = /^(?:[._]|node_modules$|__pycache__$|.*-profile$|secrets?$|credentials?$|(?:api[-_]?keys?|passwords?|credentials?|secrets?)(?:[._-]|$))/i;
function automaticSource(name: string) {
  const parts=name.split('/');
  return parts.every(part=>part&&!MATERIAL_IGNORE.test(part))&&MATERIAL_FILE.test(name);
}
function library(store: Store, projectId: string) {
  const project=store.get<Project>('projects',projectId);
  const parent=project?.parentId&&store.get<Project>('projects',project.parentId);
  if(!project||project.kind||!parent||parent.kind)return;
  const root=folderPath(parent.directory).directory, destination=folderPath(project.directory).directory;
  if(directoriesOverlap(root,destination)&&!relativeInside(root,destination))return;
  const rooms=new Set(store.list<Project>('projects').filter(item=>!item.kind&&item.id!==parent.id)
    .map(item=>folderPath(item.directory).directory).filter(folder=>relativeInside(root,folder)));
  return {root,destination,rooms};
}

export function projectMaterialCatalog(store: Store, projectId: string, query = '', exactSearch = false) {
  const source=library(store,projectId);
  if(!source)return;
  const queue=[{dir:source.root,level:0}], matches:{name:string;score:number}[]=[];
  const terms=[...new Set(query.toLowerCase().match(/[a-z][a-z0-9_-]{1,39}|\d{2,}|[\p{Script=Han}]{2,20}/gu)??[])].slice(0,20);
  let visited=0;
  for(let index=0;index<queue.length&&visited<4000;index++){
    const {dir,level}=queue[index];
    try {
      for(const entry of readdirSync(dir,{withFileTypes:true})){
        if(++visited>4000)break;
        if(MATERIAL_IGNORE.test(entry.name)||entry.isSymbolicLink())continue;
        const location=path.join(dir,entry.name);
        if(entry.isDirectory()&&level<7&&!source.rooms.has(location)){queue.push({dir:location,level:level+1});continue;}
        if(!entry.isFile()||!MATERIAL_FILE.test(entry.name))continue;
        const name=path.relative(source.root,location).replaceAll('\\','/'),lower=name.toLowerCase();
        const score=terms.reduce((total,term)=>total+(lower.includes(term)?term.length:0),0);
        matches.push({name,score});
      }
    }catch{/* Unavailable folders do not prevent reading the remaining library. */}
  }
  const sorted=matches.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  const visible=exactSearch?sorted.filter(item=>item.score>0):sorted;
  return { files:visible.slice(0,40).map(item=>item.name), hasMore:visited>=4000||visible.length>40 };
}

export function copyMeetingMaterials(store: Store, projectId: string, names: string[], current: ()=>boolean) {
  const source=library(store,projectId);
  if(!source)throw new Error('当前房间没有独立的大项目资料库。');
  if(names.some(name=>!automaticSource(name)||name.includes('\\')||name.includes(':')))
    throw new Error('请使用资料清单中的普通文件相对路径。');
  return copyProjectMaterials(store,projectId,names.map(name=>resolveSafePath(source.root,name)),current);
}
