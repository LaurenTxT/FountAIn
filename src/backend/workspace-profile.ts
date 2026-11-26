import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/types';

interface WorkspaceProfile { name?: string; major?: string; studentId?: string; timeline?: string }

function readProfile(directory:string):WorkspaceProfile|undefined {
  try {
    const root=realpathSync(directory), file=path.join(root,'AGENTS.md');
    const info=lstatSync(file);
    if(!info.isFile()||info.size>256*1024)return;
    const text=readFileSync(file,'utf8');
    const section=text.match(/^## 用户资料与时间估计（全局）[ \t]*\r?\n([\s\S]*?)(?=^#{1,2} |^---[ \t]*\r?$|(?![\s\S]))/m)?.[1];
    if(!section)return;
    const field=(label:string)=>section.match(new RegExp('^- \\*\\*'+label+'\\*\\*[：:][ \\t]*([^\\r\\n]+)','m'))?.[1]?.trim().slice(0,120);
    return {name:field('姓名'),major:field('专业'),studentId:field('学号'),timeline:section.match(/^\*\*先给 Timeline[^\r\n]+/m)?.[0].slice(0,1000)};
  }catch{return undefined;}
}

/** Use the logical workspace roots also when a room's active working directory is a task copy. */
export function workspaceProfileInstructions(projects:Project[], projectId:string|undefined, localOwnerText?:string) {
  const known=new Map(projects.filter(project=>!project.kind).map(project=>[project.id,project]));
  let profile:WorkspaceProfile|undefined;
  if(projectId){
    const seen=new Set<string>();
    let project=known.get(projectId);
    while(project&&!seen.has(project.id)){
      seen.add(project.id);
      const found=readProfile(project.directory);
      if(found){profile=found;break;}
      project=project.parentId?known.get(project.parentId):undefined;
    }
    if(!profile){
      let cursor=known.get(projectId)?.directory;
      for(let depth=0;depth<2&&cursor;depth++){
        const parentDir=path.dirname(cursor);
        if(!parentDir||parentDir===cursor)break;
        const found=readProfile(parentDir);
        if(found){profile=found;break;}
        cursor=parentDir;
      }
    }
  }else{
    const common=[...known.values()].filter(item=>!item.parentId).flatMap(item=>{
      const found=readProfile(item.directory);
      return found?[{name:found.name,major:found.major,timeline:found.timeline}]:[];
    });
    if(common.length&&common.every(item=>JSON.stringify(item)===JSON.stringify(common[0])))profile=common[0];
  }
  if(!profile)return '';
  const requiresStudentId=Boolean(localOwnerText&&/(?:学号|student (?:id|number))/i.test(localOwnerText));
  return [
    '[本地工作区资料与工作规则]',
    profile.name&&'用户正式姓名：'+profile.name+'。界面昵称和称呼偏好可以照常使用。',
    profile.major&&'用户专业：'+profile.major,
    requiresStudentId&&profile.studentId&&'用户学号：'+profile.studentId+'。只回答用户这次明确的学号请求或填写所需课程材料；勿用于公开材料或外发。',
    profile.timeline,
  ].filter(Boolean).join('\n');
}
