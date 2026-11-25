import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
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

export async function copyProjectMaterials(store: Store, projectId: string, files: unknown) {
  const project = store.get<Project>('projects', projectId);
  const parent = project?.parentId ? store.get<Project>('projects', project.parentId) : undefined;
  if (!project || project.kind || !parent || parent.kind) throw new Error('请在有独立文件夹的子项目中导入资料。');
  if (!Array.isArray(files) || !files.length || files.length > 100 || files.some(file => typeof file !== 'string'))
    throw new Error('请选择 1 到 100 个资料文件。');
  const sourceRoot = await fs.realpath(parent.directory);
  const root = await fs.realpath(project.directory);
  if (directoriesOverlap(sourceRoot, root) && !relativeInside(sourceRoot, root))
    throw new Error('子项目需要使用独立工作文件夹，才能保存专属资料。');

  return withProjectWrite(store, projectId, project.directory, async check => {
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
