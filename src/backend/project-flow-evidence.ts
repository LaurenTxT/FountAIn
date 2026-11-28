import type {Evidence} from '../shared/project-flow';
import type {TimelineEvent} from '../shared/types';
import { observeTool } from '../shared/work-log';

interface ToolData {command?:string;input?:{command?:string};rawInput?:{command?:string};id?:string|number;tool_use_id?:string|number;toolCallId?:string|number;exitCode?:number;status?:string;type?:string;is_error?:boolean}
const data=(event:TimelineEvent)=>event.data&&typeof event.data==='object'?event.data as ToolData:undefined;
export const eventCommand=(event:TimelineEvent)=>observeTool(event)?.command;
const exitCode=(event:TimelineEvent)=>observeTool(event)?.exitCode;
const failed=(event:TimelineEvent)=>observeTool(event)?.phase==='failed';
const sameId=(a:unknown,b:unknown)=>a!==undefined&&a!==''&&a===b;
function completes(start:TimelineEvent,end:TimelineEvent){
  const s=data(start),d=data(end);if(!s||!d||start.runId!==end.runId)return false;
  const terminal=['completed','failed'].includes(observeTool(end)?.phase??'');
  return terminal&&(start.id===end.id||sameId(s.id,d.id)||d.type==='tool_result'&&sameId(s.id,d.tool_use_id)||sameId(s.toolCallId,d.toolCallId));
}

/** Decode one serialized argv value, including adjacent quoted segments. Never evaluate shell syntax. */
function quotedArgument(input:string):string|undefined {
  let body='',quote='',index=0;
  for(;index<input.length;index++){
    const char=input[index];
    if(quote==="'"){if(char==="'")quote='';else body+=char;continue;}
    if(quote==='"'){
      if(char==='"'){quote='';continue;}
      if(char==='\\'&&index+1<input.length&&['"','\\','$','\x60','\n'].includes(input[index+1])){
        const escaped=input[++index];if(escaped!=='\n')body+=escaped;
      }else body+=char;
      continue;
    }
    if(/\s/.test(char))break;
    if([';', '&', '|', '<', '>', '(', ')'].includes(char))return;
    if(char==="'"||char==='"'){quote=char;continue;}
    if(char==='\\'){
      if(index+1===input.length)return;
      const escaped=input[++index];if(escaped!=='\n')body+=escaped;
    }else body+=char;
  }
  if(quote||input.slice(index).trim())return;
  return body;
}

/** Remove only recognized launch wrappers; inner command bytes remain exact. */
function unwrapCommand(command:string):string|undefined {
  const executable=command.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^\s'"]+))\s+([\s\S]+)$/);
  if(!executable)return;
  const shell=(executable[1]??executable[2]??executable[3]).split(/[\\/]/).at(-1)?.toLowerCase();
  let rest=executable[4],flag:RegExpExecArray|null;
  if(['powershell','powershell.exe','pwsh','pwsh.exe'].includes(shell??'')){
    while((flag=/^-(?:NoProfile|NoLogo|NonInteractive)\s+/i.exec(rest)))rest=rest.slice(flag[0].length);
    flag=/^-Command\s+/i.exec(rest);
  }else if(['cmd','cmd.exe'].includes(shell??'')){
    while((flag=/^\/(?:d|s)\s+/i.exec(rest)))rest=rest.slice(flag[0].length);
    flag=/^\/c\s+/i.exec(rest);
  }else if(['bash','bash.exe','sh','sh.exe'].includes(shell??'')){
    flag=/^(?:--login\s+)?-(?:lc|c)\s+/.exec(rest);
  }else return;
  if(!flag)return;
  const body=rest.slice(flag[0].length);
  return body.startsWith("'")||body.startsWith('"')?quotedArgument(body):body;
}
function commandForMatching(command:string):string {
  for(let depth=0;depth<8;depth++){
    const body=unwrapCommand(command);if(body===undefined||body===command)break;
    command=body;
  }
  return command;
}
function normalizedCommandBody(command:string):string {
  return commandForMatching(command)
    .trim()
    .replace(/^(?:cd|set-location)\s+(?:\/d\s+)?(?:"[^"]*"|'[^']*'|[^\s;&]+)\s*(?:&&|;)\s*/i, '')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ');
}

/** Match a summarized heredoc only when an event reference or a unique output name identifies its invocation. */
function summarizedHeredocStart(evidence: Evidence, events: TimelineEvent[]) {
  const reported = evidence.command && commandForMatching(evidence.command).trim();
  const header = reported && /^([^\r\n]+?<<-?\s*(['"]?)[A-Za-z_][\w-]*\2)(?:\s+[（(]([^\r\n]*)[）)])?$/.exec(reported);
  if (!header) return [];
  const outputNames = [...new Set(header[3]?.match(/[A-Za-z0-9_.-]+\.(?:txt|json|csv|md|log)\b/gi) ?? [])];
  const candidates = events.filter(event => {
    const native = eventCommand(event);
    if (!native) return false;
    const body = commandForMatching(native);
    return body.includes('\n') && normalizedCommandBody(body.split(/\r?\n/, 1)[0]) === normalizedCommandBody(header[1]);
  });
  const referenced = candidates.filter(start => events.some(end =>
    completes(start, end) && (evidence.eventIds.includes(start.id) || evidence.eventIds.includes(end.id)),
  ));
  if (referenced.length) return referenced.length === 1 ? referenced : [];
  if (!outputNames.length) return [];
  const identified = candidates.filter(start => {
    const literals = new Set((eventCommand(start) ?? '').match(/[A-Za-z0-9_.-]+\.(?:txt|json|csv|md|log)\b/gi) ?? []);
    return outputNames.every(name => literals.has(name));
  });
  return identified.length === 1 ? identified : [];
}

/** A completed shell tool call may generate a script and run it on its last line. */
function summarizedPythonStart(evidence: Evidence, events: TimelineEvent[]) {
  const reported = evidence.command && commandForMatching(evidence.command).trim();
  const match = reported && /^(python(?:3|\.exe)?\s+(?:-I\s+)?[\w./\\-]+\.py)(?:\s*[（(](?:脚本|说明|校验|输出|script|note)\s*[：:][^\r\n]*[）)])?$/i.exec(reported);
  if (!match) return [];
  const expected = normalizedCommandBody(match[1]);
  const matches = events.filter(event => {
    const native = eventCommand(event);
    if (!native) return false;
    if (normalizedCommandBody(native) === expected) return true;
    const lines = commandForMatching(native).trimEnd().split(/\r?\n/);
    const shellHeader = lines[0]?.match(/(?:^|&&\s*)cat\s+>\s*([\w./\\-]+\.py)\s+<<\s*(['"]?)([A-Za-z_]\w*)\2\s*$/);
    return lines.length >= 4 && shellHeader && lines.at(-2) === shellHeader[3] &&
      expected.endsWith(' ' + shellHeader[1].replace(/\\/g, '/')) &&
      normalizedCommandBody(lines.at(-1)!) === expected;
  });
  const referenced = matches.filter(start => events.some(end =>
    completes(start, end) && (evidence.eventIds.includes(start.id) || evidence.eventIds.includes(end.id)),
  ));
  if (referenced.length) return referenced.length === 1 ? referenced : [];
  return matches.length === 1 ? matches : [];
}

/** Command completion and the member's exit-code claim are independent observations. */
export function bindFlowEvidence(evidence:Evidence[],allEvents:TimelineEvent[],runIds:string[]):Evidence[]{
  const events=allEvents.filter(e=>runIds.includes(e.runId)&&e.fidelity==='native'&&['tool','output'].includes(e.kind));
  return evidence.map(e=>{
    if(e.kind!=='command'&&!e.commandKindInferred)return {...e,eventIds:e.eventIds.filter(id=>events.some(event=>event.id===id)),source:e.eventIds.some(id=>events.some(event=>event.id===id))?'observed':'reported'};
    const command=typeof e.command==='string'?commandForMatching(e.command):undefined;
    const norm=typeof e.command==='string'?normalizedCommandBody(e.command):undefined;
    const exactStarts=events.filter(event=>{const native=eventCommand(event);return typeof native==='string'&&command!==undefined&&commandForMatching(native)===command;});
    const normalizedStarts=exactStarts.length?exactStarts:events.filter(event=>{const native=eventCommand(event);return typeof native==='string'&&norm!==undefined&&norm.length>0&&normalizedCommandBody(native)===norm;});
    const heredocStarts = normalizedStarts.length ? [] : summarizedHeredocStart(e, events);
    const starts = normalizedStarts.length ? normalizedStarts
      : heredocStarts.length ? heredocStarts : summarizedPythonStart(e, events);
    const completed=events.filter(end=>starts.some(start=>completes(start,end)));
    // Prefer a recorded matching invocation; otherwise keep a completion whose code is unavailable.
    const matching=e.exitCode===undefined?completed:completed.filter(event=>exitCode(event)===e.exitCode&&!(e.exitCode===0&&failed(event)));
    const unknown=completed.filter(event=>exitCode(event)===undefined&&!(e.exitCode===0&&failed(event)));
    const selected=matching.length?matching:unknown.length?unknown:completed,end=selected.at(-1),observed=end?exitCode(end):undefined;
    return {...e,eventIds:selected.map(event=>event.id),source:completed.length?'observed':'reported',
      ...(end?{executionStatus:failed(end)?'failed' as const:'completed' as const}:{}),
      ...(observed===undefined?{}:{observedExitCode:observed}),
      ...(e.exitCode===undefined?{}:{exitCodeSource:observed===e.exitCode?'observed' as const:'reported' as const})};
  });
}
