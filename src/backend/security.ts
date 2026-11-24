import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/types';
import { nodeRuntimeEnvironment } from './node-runtime';

const sensitiveKey = /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|auth[_-]?token|token|authorization|password|passwd|secret|credentials|cookie|set-cookie)$/i;
const knownSecrets = new Set(Object.entries(process.env).filter(([key,value]) => sensitiveKey.test(key) && value && value.length >= 8).map(([,value])=>value!));

/** Register runtime credentials so plain-text echoes are also redacted. Retained for this process lifetime to cover delayed output. */
export function registerSecret(value:string):void {
  if (value.length>=8 && value.length<=16384) knownSecrets.add(value);
}

/** Remove credentials before persisting or forwarding diagnostic material. */
export function redact<T>(value:T):T {
  // Only ancestors count as cycles; the same object shared by siblings (e.g. one options array) is fine.
  const ancestors = new Set<object>();
  function visit(item:unknown, depth=0):unknown {
    if (depth > 40) return '[depth limited]';
    if (typeof item === 'string') {
      let result = item.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[credential redacted]')
        .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g, '[credential redacted]')
        .replace(/(https?:\/\/)[^\s/:]+:[^\s/@]+@/gi, '$1[credential redacted]@')
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|auth[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s,"';]+/gi, '$1[credential redacted]');
      for (const secret of knownSecrets) result = result.split(secret).join('[credential redacted]');
      return result;
    }
    if (item === null || typeof item !== 'object') return item;
    if (ancestors.has(item)) return '[circular]';
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map(entry=>visit(entry,depth+1));
      const result:Record<string,unknown> = {};
      for (const [key,entry] of Object.entries(item)) result[key] = sensitiveKey.test(key) ? '[credential redacted]' : visit(entry,depth+1);
      return result;
    } finally { ancestors.delete(item); }
  }
  return visit(value) as T;
}

function contained(root:string, target:string) {
  const relative = path.relative(root,target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Validate both lexical paths and any existing symlinks/junctions. */
export function resolveSafePath(root:string, relative=''):string {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.includes(':')) throw new Error('文件路径必须在所选工作区内。');
  const realRoot = realpathSync(root);
  const candidate = path.resolve(realRoot,relative);
  if (!contained(realRoot,candidate)) throw new Error('文件路径超出所选工作区。');
  let ancestor=candidate;
  while (!existsSync(ancestor)) {
    const parent=path.dirname(ancestor);
    if (parent===ancestor) throw new Error('无法校验文件路径。');
    ancestor=parent;
  }
  if (!contained(realRoot,realpathSync(ancestor))) throw new Error('文件链接指向工作区之外。');
  return candidate;
}

export function validateProxyUrl(value:string):URL {
  let url:URL;
  try { url=new URL(value); } catch { throw new Error('代理地址无效，请填写完整的 HTTP 或 HTTPS 地址。'); }
  if (!['http:','https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('代理地址只支持不含账户密码的 HTTP 或 HTTPS 地址。');
  return url;
}

/** Anthropic-compatible service address for Claude API mode. HTTPS only, except plain HTTP to this machine (local relays). */
export function claudeApiBaseUrl(value:string):string {
  let url:URL;
  try { url=new URL(value.trim()); } catch { throw new Error('Claude API 服务地址无效，请填写完整的 https:// 地址。'); }
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (!(url.protocol==='https:'||url.protocol==='http:'&&local) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error('Claude API 服务地址需为 https://（本机中转可用 http://localhost），且不含账户密码、查询参数。');
  return url.toString().replace(/\/$/,'');
}

let cachedSystemProxy: { at: number; url?: string } | undefined;

/** Read Windows System Proxy (e.g. Clash Verge system proxy 127.0.0.1:7897) so CLI tools work even when TUN is off. */
export function detectWindowsSystemProxy(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const now = Date.now();
  if (cachedSystemProxy && now - cachedSystemProxy.at < 15_000) return cachedSystemProxy.url;
  let url: string | undefined;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      { encoding: 'utf8', windowsHide: true, timeout: 1500 },
    );
    if (/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) {
      const srvOut = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
        { encoding: 'utf8', windowsHide: true, timeout: 1500 },
      );
      const match = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(srvOut);
      let raw = match?.[1]?.trim() ?? '';
      if (raw.includes('=')) {
        const httpsPart = raw.split(';').map(s => s.trim()).find(s => /^https=/i.test(s));
        const httpPart = raw.split(';').map(s => s.trim()).find(s => /^http=/i.test(s));
        raw = (httpsPart ?? httpPart ?? '').replace(/^https?=/i, '').trim();
      }
      if (raw) {
        const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
        url = validateProxyUrl(candidate).toString();
      }
    }
  } catch {
    url = undefined;
  }
  cachedSystemProxy = { at: now, url };
  return url;
}

export function buildEnvironment(settings:Settings):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={...process.env};
  for (const key of Object.keys(env)) {
    if (/^(?:http_proxy|https_proxy|all_proxy|npm_config_proxy|npm_config_https_proxy|anthropic_api_key|anthropic_auth_token|claude_code_resume_interrupted_turn)$/i.test(key)) delete env[key];
  }
  const resolvedProxy = settings.networkMode==='proxy'
    ? validateProxyUrl(settings.proxyUrl).toString()
    : detectWindowsSystemProxy();
  if (resolvedProxy) {
    env.HTTP_PROXY=resolvedProxy; env.HTTPS_PROXY=resolvedProxy; env.npm_config_proxy=resolvedProxy; env.npm_config_https_proxy=resolvedProxy;
  }
  const bypass=Object.entries(env).filter(([key])=>/^no_proxy$/i.test(key)).flatMap(([,value])=>(value??'').split(',')).map(value=>value.trim()).filter(Boolean);
  for (const key of Object.keys(env)) if (/^no_proxy$/i.test(key)) delete env[key];
  env.NO_PROXY=[...new Set([...bypass,'localhost','127.0.0.1','::1','[::1]'])].join(',');
  env.FOUNTAIN_CLAUDE_AUTH_MODE=settings.claudeAuthMode==='api'?'api':'subscription';
  delete env.FOUNTAIN_CLAUDE_BASE_URL;delete env.FOUNTAIN_CLAUDE_KEY_HEADER;
  if(settings.claudeAuthMode==='api'){
    if(settings.claudeApiBaseUrl?.trim())env.FOUNTAIN_CLAUDE_BASE_URL=claudeApiBaseUrl(settings.claudeApiBaseUrl);
    env.FOUNTAIN_CLAUDE_KEY_HEADER=settings.claudeApiKeyHeader==='bearer'?'bearer':'x-api-key';
  }
  env.npm_config_registry=settings.npmRegistry==='npmmirror'?'https://registry.npmmirror.com/':'https://registry.npmjs.org/';
  return nodeRuntimeEnvironment(settings,env);
}
