import {randomUUID} from 'node:crypto';
import type {Project} from '../shared/types';
import {descendantIds,projectRows} from '../shared/project-tree';
import {FlowError} from '../shared/project-flow';
import {normalizeWriteScopes,assertProjectAdmission,assertProjectIdle,directoriesOverlap} from './project-access';
import {initializeStudyRoom,readStudyRoom,STUDY_WRITE_SCOPES,studyBriefLeader,studyWriteScopes} from './study-room';
import type {Store} from './store';
import {folderPath} from './folder-path';
import path from 'node:path';
export class ProjectTree {
  constructor(private store:Store,private removing:(id:string)=>boolean=()=>false){}
  /** task workspace: the Leader named in ROOM_BRIEF (e.g. `[Agent: Gemini]`) becomes the meeting Leader, so a resumed task keeps its owner. */
  private studyLeader(brief:string){const name=studyBriefLeader(brief)?.toLowerCase();if(!name)return undefined;const aliases:Record<string,string[]>={deepseek:['deepseek','dsh']};const wanted=aliases[name]??[name];return this.store.members().find(member=>wanted.some(alias=>member.name.toLowerCase().includes(alias)||String(member.executor).toLowerCase()===alias))?.id;}
  private work(id:string){const p=this.store.get<Project>('projects',id);if(!p||p.kind)throw new FlowError('NOT_FOUND','工作项目不存在。');if(this.removing(id))throw new FlowError('PROJECT_ACTIVE','项目正在移除，请稍后操作。');return p;}
  private parent(value:unknown,id?:string){if(value===undefined||value===null||value==='')return undefined;if(typeof value!=='string')throw new FlowError('INVALID_PARENT','请选择有效的父项目。');const parent=this.work(value),seen=new Set<string>();let current:Project|undefined=parent;while(current){if(current.id===id||seen.has(current.id))throw new FlowError('PROJECT_CYCLE','项目不能移到自己或自己的子项目下面。');seen.add(current.id);current=current.parentId?this.work(current.parentId):undefined;}return parent.id;}
  private order(value:unknown,parentId?:string){if(value===undefined)return Math.max(-1,...this.store.list<Project>('projects').filter(p=>!p.kind&&p.parentId===parentId).map(p=>p.order??0))+1;if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>1000000)throw new FlowError('INVALID_ORDER','同级顺序须为 0 至 1000000 的整数。');return value;}
  private once<T>(method:string,p:Record<string,unknown>,job:()=>T):T{if(p.requestId===undefined)return this.store.transaction(job);if(typeof p.requestId!=='string'||!p.requestId||p.requestId.length>200)throw new FlowError('INVALID_REQUEST','操作编号无效。');const signature=JSON.stringify([method,Object.fromEntries(Object.entries(p).sort(([a],[b])=>a.localeCompare(b)))]),old=this.store.get<{signature:string;result:T}>('project_tree_requests',p.requestId);if(old){if(old.signature!==signature)throw new FlowError('IDEMPOTENCY_CONFLICT','操作编号已用于另一项变更。');return old.result;}let result:T;this.store.transaction(()=>{result=job();this.store.put('project_tree_requests',String(p.requestId),{signature,result});});return result!;}
  private canInitialize(directory:string,parentId:string){
    const parent=this.work(parentId), destination=folderPath(directory).key, root=folderPath(parent.directory).key;
    const parentFromRoom=path.relative(destination,root);
    return !directoriesOverlap(destination,root)||parentFromRoom==='..'||parentFromRoom.startsWith('..'+path.sep);
  }
  create(directory:string,p:Record<string,unknown>):Project{
    return this.once('create',p,()=>{
      const parentId=this.parent(p.parentId),order=this.order(p.order,parentId);
      const name=String(p.name||path.basename(directory)).trim().slice(0,120);
      if(!name)throw new FlowError('INVALID_REQUEST','项目名称不能为空。');
      const scopes=p.writeScopes===undefined?undefined:normalizeWriteScopes(directory,p.writeScopes);
      const independent=parentId&&this.canInitialize(directory,parentId);
      if(parentId&&p.initializeRoom===true&&!independent)
        throw new FlowError('STUDY_ROOM_BOUNDARY','任务房需要独立文件夹；共用大项目文件夹时请取消初始化。');
      if(independent&&p.initializeRoom!==false) {
        if(scopes&&!(scopes.length===1&&scopes[0]==='.')&&scopes.some(scope=>!STUDY_WRITE_SCOPES.some(allowed=>scope===allowed||scope.startsWith(allowed+'/'))))
          throw new FlowError('STUDY_WRITE_BOUNDARY','任务房的修改范围只能在草稿或审查目录内。');
        initializeStudyRoom(directory,name);
      }
      const study=readStudyRoom(directory),writeScopes=studyWriteScopes(directory,scopes);
      const project:Project={id:randomUUID(),name,directory,createdAt:new Date().toISOString(),collaborationPaused:false,hierarchyRevision:1,order,...(parentId?{parentId}:{}),...(writeScopes?{writeScopes}:{})};
      const leader=study&&this.studyLeader(study.brief);if(leader)project.meetingLeaderId=leader;
      this.store.put('projects',project.id,project);this.store.ensureProjectRoom(project.id,true);return project;
    });
  }
  initialize(projectId:string) {
    const project=this.work(projectId);
    if(!project.parentId||!this.canInitialize(project.directory,project.parentId))
      throw new FlowError('STUDY_ROOM_BOUNDARY','请选择使用独立文件夹的子项目。');
    assertProjectIdle(this.store,project.id);
    assertProjectAdmission(this.store,project.id,true);
    const scopes=project.writeScopes;
    if(scopes&&!(scopes.length===1&&scopes[0]==='.')&&scopes.some(scope=>!STUDY_WRITE_SCOPES.some(allowed=>scope===allowed||scope.startsWith(allowed+'/'))))
      throw new FlowError('STUDY_WRITE_BOUNDARY','请先把修改范围调整到草稿或审查目录。');
    initializeStudyRoom(project.directory,project.name);
    const study=readStudyRoom(project.directory);
    const leader=study&&this.studyLeader(study.brief);
    this.store.put('projects',project.id,{...project,writeScopes:studyWriteScopes(project.directory,scopes),
      meetingLeaderId:project.meetingLeaderId??leader,hierarchyRevision:(project.hierarchyRevision??0)+1});
    return study;
  }
  move(p:Record<string,unknown>):Project{return this.once('move',p,()=>{const project=this.work(String(p.projectId));if(p.expectedRevision!==(project.hierarchyRevision??0))throw new FlowError('STALE_REVISION','项目归属或范围已更新，请刷新后再保存。');for(const key of Object.keys(p))if(!['projectId','parentId','order','writeScopes','expectedRevision','requestId'].includes(key))throw new FlowError('INVALID_REQUEST','不支持的项目字段：'+key);const parentId=Object.hasOwn(p,'parentId')?this.parent(p.parentId,project.id):project.parentId,order=p.order===undefined?project.order??0:this.order(p.order,parentId),writeScopes=studyWriteScopes(project.directory,p.writeScopes===undefined?project.writeScopes:normalizeWriteScopes(project.directory,p.writeScopes));if(JSON.stringify([...(writeScopes??['.'])].sort())!==JSON.stringify([...(project.writeScopes??['.'])].sort()))assertProjectIdle(this.store,project.id);const next={...project,parentId,order,writeScopes,hierarchyRevision:(project.hierarchyRevision??0)+1};this.store.put('projects',next.id,next);return next;});}
  reorder(p:Record<string,unknown>):void {
    this.once('reorder',p,()=>{
      const project=this.work(String(p.projectId)),target=this.work(String(p.targetId));
      if(project.parentId!==target.parentId || project.id===target.id)throw new FlowError('INVALID_ORDER','只能拖动调整同级项目的顺序。');
      if(p.expectedRevision!==(project.hierarchyRevision??0) || p.targetRevision!==(target.hierarchyRevision??0))
        throw new FlowError('STALE_REVISION','项目顺序已更新，请重新拖动。');
      if(p.position!=='before'&&p.position!=='after')throw new FlowError('INVALID_ORDER','请选择放在目标项目上方或下方。');
      const siblings=projectRows(this.store.list<Project>('projects')).map(row=>row.project)
        .filter(item=>item.parentId===project.parentId&&item.id!==project.id);
      siblings.splice(siblings.findIndex(item=>item.id===target.id)+(p.position==='after'?1:0),0,project);
      siblings.forEach((item,order)=>{if(item.order!==order)this.store.put('projects',item.id,{...item,order,hierarchyRevision:(item.hierarchyRevision??0)+1});});
      return {reordered:true};
    });
  }
  assertRemovable(projectId:string){this.work(projectId);if(descendantIds(this.store.list<Project>('projects'),projectId).length>1)throw new FlowError('PROJECT_HAS_CHILDREN','请先把子项目移到其他归属或移为独立项目，再移除父项目。');assertProjectIdle(this.store,projectId);}
}
