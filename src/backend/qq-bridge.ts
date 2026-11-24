import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import os from 'node:os';
import type { Duplex } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import type { QqBridgeSettings, QqBridgeStatus, RoomId } from '../shared/types';

export interface QqInboundMessage {
  messageId: string;
  chatType: 'private' | 'group';
  userId: string;
  groupId?: string;
  senderName: string;
  text: string;
  imageUrls: string[];
  mentionedBot: boolean;
}

export interface QqReplyTarget {
  chatType: 'private' | 'group';
  userId: string;
  groupId?: string;
}

export interface QqBridgeHost {
  onMessage: (msg: QqInboundMessage) => Promise<void> | void;
  onChanged: () => void;
  resolveRoomName: (roomId: RoomId) => string;
}

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CHUNK_CHARS = 1800;

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function splitTextChunks(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= MAX_CHUNK_CHARS) return [clean];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > MAX_CHUNK_CHARS) {
    let cut = rest.lastIndexOf('\n', MAX_CHUNK_CHARS);
    if (cut < MAX_CHUNK_CHARS * 0.4) cut = MAX_CHUNK_CHARS;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function extractOneBotContent(raw: unknown, rawFallback: unknown, botQq?: string): { text: string; imageUrls: string[]; mentionedBot: boolean } {
  let mentionedBot = false;
  const imageUrls: string[] = [];
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const seg of raw) {
      if (!seg || typeof seg !== 'object') continue;
      const type = String((seg as { type?: unknown }).type ?? '');
      const data = ((seg as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
      if (type === 'text') {
        const t = String(data.text ?? '');
        if (t) parts.push(t);
      } else if (type === 'image') {
        const url = String(data.url ?? data.file ?? '').trim();
        if (url && /^https?:\/\//i.test(url)) imageUrls.push(url);
        else if (url) parts.push('[图片]');
      } else if (type === 'at') {
        const qq = String(data.qq ?? '').trim();
        if (botQq && qq === botQq) mentionedBot = true;
      } else if (type === 'mface') {
        const summary = String(data.summary ?? '').trim();
        parts.push(summary || '[表情]');
      } else if (type === 'face') {
        parts.push('[QQ表情]');
      } else if (type === 'json') {
        parts.push('[卡片消息]');
      } else if (type === 'file') {
        const fname = String(data.file ?? data.name ?? '').trim();
        parts.push(fname ? `[文件: ${fname}]` : '[文件]');
      }
    }
    const joined = parts.join('').trim();
    if (joined || imageUrls.length || mentionedBot) {
      return { text: joined, imageUrls, mentionedBot };
    }
  }
  const str = String(rawFallback ?? raw ?? '');
  if (botQq && str.includes(`[CQ:at,qq=${botQq}`)) mentionedBot = true;
  for (const m of str.matchAll(/\[CQ:image,[^\]]*url=([^,\]]+)/gi)) {
    const url = m[1].replace(/&amp;/g, '&').trim();
    if (/^https?:\/\//i.test(url)) imageUrls.push(url);
  }
  const cleaned = str.replace(/\[CQ:[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
  return { text: cleaned, imageUrls, mentionedBot };
}

/** Zero-dependency OneBot v11 Reverse WebSocket server for NapCat QQ bridge. */
export class QqBridgeController {
  private settings: QqBridgeSettings = { enabled: false, host: '127.0.0.1', port: 8643 };
  private server?: Server;
  private socket?: Duplex;
  private listening = false;
  private botQq?: string;
  private botAvatarDataUrl?: string;
  private fetchedAvatarQq?: string;
  private lastSenderQq?: string;
  private lastGroupId?: string;
  private lastEventAt?: string;
  private lastDebug?: string;
  private error?: string;
  private activeRoomId: RoomId = 'global';
  private seenMsgIds = new Set<string>();
  private bindKey = '';
  private autoLaunchTimer?: NodeJS.Timeout;

  constructor(private host: QqBridgeHost) {}

  getActiveRoomId(): RoomId {
    return this.activeRoomId;
  }

  setActiveRoomId(roomId: RoomId) {
    if (this.activeRoomId !== roomId) {
      this.activeRoomId = roomId;
      this.host.onChanged();
    }
  }

  status(): QqBridgeStatus {
    const host = (this.settings.host || '127.0.0.1').trim() || '127.0.0.1';
    const port = this.settings.port || 8643;
    return {
      enabled: Boolean(this.settings.enabled),
      listening: this.listening,
      connected: Boolean(this.socket && !this.socket.destroyed),
      host,
      port,
      botQq: this.botQq,
      botAvatarDataUrl: this.botAvatarDataUrl,
      activeRoomId: this.activeRoomId,
      activeRoomName: this.host.resolveRoomName(this.activeRoomId),
      lastSenderQq: this.lastSenderQq,
      lastGroupId: this.lastGroupId,
      lastEventAt: this.lastEventAt,
      lastDebug: this.lastDebug,
      error: this.error,
    };
  }

  reconfigure(next?: QqBridgeSettings) {
    const normalized: QqBridgeSettings = {
      enabled: Boolean(next?.enabled),
      host: (next?.host || '127.0.0.1').trim() || '127.0.0.1',
      port: typeof next?.port === 'number' && Number.isFinite(next.port) && next.port >= 1024 && next.port <= 65535
        ? Math.floor(next.port)
        : 8643,
      token: next?.token?.trim() || undefined,
      allowedUsers: (next?.allowedUsers ?? []).map((s) => String(s).trim()).filter(Boolean),
      allowedGroups: (next?.allowedGroups ?? []).map((s) => String(s).trim()).filter(Boolean),
      allowAllGroups: Boolean(next?.allowAllGroups),
      defaultRoomId: next?.defaultRoomId || this.activeRoomId || 'global',
      napcatLauncher: next?.napcatLauncher?.trim() || undefined,
      napcatQq: next?.napcatQq?.trim() || undefined,
      autoLaunchNapcat: next?.autoLaunchNapcat !== false,
    };
    this.settings = normalized;
    if (normalized.defaultRoomId) this.activeRoomId = normalized.defaultRoomId;

    const nextKey = normalized.enabled ? `${normalized.host}:${normalized.port}` : '';
    if (nextKey === this.bindKey) {
      this.scheduleAutoLaunch();
      this.host.onChanged();
      return;
    }
    this.stopServer();
    this.bindKey = nextKey;
    if (!normalized.enabled) {
      this.error = undefined;
      this.host.onChanged();
      return;
    }
    this.startServer(normalized.host!, normalized.port);
  }

  close() {
    this.stopServer();
    this.bindKey = '';
  }

  private stopServer() {
    if (this.autoLaunchTimer) {
      clearTimeout(this.autoLaunchTimer);
      this.autoLaunchTimer = undefined;
    }
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
      this.socket = undefined;
    }
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = undefined;
    }
    this.listening = false;
    this.botQq = undefined;
    this.botAvatarDataUrl = undefined;
    this.fetchedAvatarQq = undefined;
  }

  private setBotQq(qq: string) {
    const clean = qq.trim();
    if (!clean) return;
    if (clean !== this.botQq) {
      this.botQq = clean;
      this.host.onChanged();
    }
    if (this.fetchedAvatarQq === clean) return;
    this.fetchedAvatarQq = clean;
    void (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(clean)}&s=100`, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (!buf.length || buf.length > 512 * 1024) return;
        const ct = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
        if (this.botQq === clean) {
          this.botAvatarDataUrl = `data:${ct};base64,${buf.toString('base64')}`;
          this.host.onChanged();
        }
      } catch {
        // Fallback to default QQ icon if offline or blocked.
      }
    })();
  }

  private startServer(host: string, port: number) {
    this.error = undefined;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('FountAIn OneBot v11 QQ Bridge (WebSocket endpoint: /ws)\n');
    });
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.listening = false;
      this.error =
        err.code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用（如果正在运行大肥鱼 DeepSeek Harness，请先关闭它，或改用 8644 等其他端口）。`
          : `监听失败：${err.message}`;
      this.host.onChanged();
    });
    server.listen(port, host, () => {
      if (this.server !== server) {
        try { server.close(); } catch {}
        return;
      }
      this.listening = true;
      this.error = undefined;
      this.host.onChanged();
      this.scheduleAutoLaunch();
    });
    this.server = server;
  }

  private scheduleAutoLaunch() {
    if (this.autoLaunchTimer) {
      clearTimeout(this.autoLaunchTimer);
      this.autoLaunchTimer = undefined;
    }
    if (
      !this.listening ||
      (this.socket && !this.socket.destroyed) ||
      this.settings.autoLaunchNapcat === false ||
      !this.settings.napcatLauncher?.trim()
    ) {
      return;
    }
    // Give an already-running NapCat 6s (reconnectInterval = 5s) to connect first before spawning a new one.
    this.autoLaunchTimer = setTimeout(() => {
      this.autoLaunchTimer = undefined;
      if (!this.listening || (this.socket && !this.socket.destroyed) || this.settings.autoLaunchNapcat === false) {
        return;
      }
      if (process.platform === 'win32') {
        try {
          const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/NH'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 4000,
          });
          if (/NapCatWinBootMain\.exe/i.test(out)) return;
        } catch {}
      }
      try {
        this.launchNapcat();
        this.lastDebug = '已随 FountAIn 自动在后台拉起 NapCat，等待登录连入…';
        this.host.onChanged();
      } catch (err) {
        this.lastDebug = `自动启动 NapCat 失败：${(err as Error).message}`;
        this.host.onChanged();
      }
    }, 6000);
    this.autoLaunchTimer.unref?.();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname !== '/ws' && url.pathname !== '/' && url.pathname !== '/onebot/v11/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const requiredToken = this.settings.token?.trim();
    if (requiredToken) {
      const auth = String(req.headers.authorization ?? '');
      const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : auth.trim();
      const queryToken = url.searchParams.get('access_token') || '';
      if (bearer !== requiredToken && queryToken !== requiredToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    if (this.socket && this.socket !== socket) {
      try { this.socket.destroy(); } catch {}
    }
    this.socket = socket;
    this.error = undefined;
    this.lastEventAt = new Date().toISOString();
    const selfHeader = req.headers['x-self-id'];
    if (typeof selfHeader === 'string' && selfHeader.trim()) this.setBotQq(selfHeader.trim());
    this.host.onChanged();

    let buffer: Buffer<ArrayBufferLike> = head.length ? Buffer.from(head) : Buffer.alloc(0);
    let fragChunks: Buffer[] = [];
    let fragOpcode = 0;

    const drainFrames = () => {
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          const bigLen = buffer.readBigUInt64BE(2);
          if (bigLen > BigInt(32 * 1024 * 1024)) {
            socket.destroy();
            return;
          }
          payloadLen = Number(bigLen);
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buffer.length < offset + maskLen + payloadLen) return;
        let payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + payloadLen));
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        buffer = buffer.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x8) {
          // Close frame
          try { socket.write(encodeWsFrame(0x8, Buffer.alloc(0))); } catch {}
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          // Ping -> Pong
          try { socket.write(encodeWsFrame(0xa, payload)); } catch {}
          continue;
        }
        if (opcode === 0xa) continue; // Pong

        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            if (opcode === 0x1) this.handleWsText(payload.toString('utf8'));
          } else {
            fragOpcode = opcode;
            fragChunks = [payload];
          }
        } else if (opcode === 0x0 && fragChunks.length) {
          fragChunks.push(payload);
          if (fin) {
            const full = Buffer.concat(fragChunks);
            const op = fragOpcode;
            fragChunks = [];
            fragOpcode = 0;
            if (op === 0x1) this.handleWsText(full.toString('utf8'));
          }
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      drainFrames();
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.host.onChanged();
      }
    });
    socket.on('error', () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.host.onChanged();
      }
    });
    if (buffer.length) drainFrames();
  }

  private handleWsText(rawText: string) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      return;
    }
    this.lastEventAt = new Date().toISOString();
    if (payload.self_id !== undefined && payload.self_id !== null) {
      const nextBot = String(payload.self_id);
      if (nextBot) this.setBotQq(nextBot);
    }
    if (payload.post_type === 'meta_event') return;
    if (payload.post_type !== 'message') return;

    const messageType = String(payload.message_type ?? '');
    if (messageType !== 'private' && messageType !== 'group') return;

    const userId = String(payload.user_id ?? '').trim();
    if (!userId || (this.botQq && userId === this.botQq)) return;

    const msgId = String(payload.message_id ?? randomUUID());
    if (this.seenMsgIds.has(msgId)) return;
    this.seenMsgIds.add(msgId);
    if (this.seenMsgIds.size > 200) {
      const first = this.seenMsgIds.values().next().value;
      if (first) this.seenMsgIds.delete(first);
    }

    const groupId = messageType === 'group' ? String(payload.group_id ?? '').trim() : undefined;
    const { text: extractedText, imageUrls, mentionedBot: nativeAt } = extractOneBotContent(payload.message, payload.raw_message, this.botQq);
    const textAt = /@(?:大肥鱼|deepseek|dsh|机器人)/i.test(extractedText) || Boolean(this.botQq && extractedText.includes(`@${this.botQq}`));
    const mentionedBot = nativeAt || textAt;
    const text = extractedText || (mentionedBot && !imageUrls.length ? '在吗？（@了你）' : '');

    if (userId !== this.lastSenderQq) {
      this.lastSenderQq = userId;
      this.host.onChanged();
    }
    if (messageType === 'group' && groupId && groupId !== this.lastGroupId) {
      this.lastGroupId = groupId;
      this.host.onChanged();
    }

    if (!text && !imageUrls.length) {
      this.lastDebug = `忽略空消息（${messageType === 'group' ? `群 ${groupId}` : `私聊 ${userId}`}）`;
      this.host.onChanged();
      return;
    }

    if (messageType === 'private') {
      const allowedUsers = this.settings.allowedUsers ?? [];
      if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
        this.lastDebug = `私聊被白名单拦截：QQ ${userId}`;
        this.host.onChanged();
        return;
      }
    } else {
      const allowedGroups = this.settings.allowedGroups ?? [];
      const inAllowedGroup = Boolean(groupId && allowedGroups.includes(groupId));
      if (!groupId || (!this.settings.allowAllGroups && !inAllowedGroup)) {
        this.lastDebug = `群 ${groupId} 未在允许列表中（可点击下方一键加入，或打开任意群开关）`;
        this.host.onChanged();
        return;
      }
      if (!mentionedBot && !text.startsWith('/')) {
        this.lastDebug = `群 ${groupId} 消息未 @ 机器人，已忽略`;
        this.host.onChanged();
        return;
      }
    }

    this.lastDebug = `已接收 ${messageType === 'group' ? `群 ${groupId}` : `私聊 ${userId}`}：${(text || '[图片]').slice(0, 36)}`;
    this.host.onChanged();

    const senderObj = (payload.sender ?? {}) as Record<string, unknown>;
    const senderName = String(senderObj.card || senderObj.nickname || userId);
    void Promise.resolve(
      this.host.onMessage({
        messageId: msgId,
        chatType: messageType,
        userId,
        groupId,
        senderName,
        text,
        imageUrls,
        mentionedBot,
      }),
    ).catch(() => {});
  }

  private sendAction(action: string, params: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    const frame = encodeWsFrame(0x1, Buffer.from(JSON.stringify({ action, params, echo: randomUUID() }), 'utf8'));
    try {
      this.socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  sendReply(target: QqReplyTarget, text: string, imagePaths: string[] = []): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    const chunks = splitTextChunks(text);
    let sent = false;
    for (const chunk of chunks) {
      const segments: Record<string, unknown>[] = [{ type: 'text', data: { text: chunk } }];
      const ok =
        target.chatType === 'group' && target.groupId
          ? this.sendAction('send_group_msg', { group_id: Number(target.groupId), message: segments })
          : this.sendAction('send_private_msg', { user_id: Number(target.userId), message: segments });
      if (ok) sent = true;
    }
    for (const imgPath of imagePaths) {
      try {
        if (!existsSync(imgPath)) continue;
        const base64 = readFileSync(imgPath).toString('base64');
        const segments = [{ type: 'image', data: { file: `base64://${base64}` } }];
        const ok =
          target.chatType === 'group' && target.groupId
            ? this.sendAction('send_group_msg', { group_id: Number(target.groupId), message: segments })
            : this.sendAction('send_private_msg', { user_id: Number(target.userId), message: segments });
        if (ok) sent = true;
      } catch {
        // Ignore unreadable image files.
      }
    }
    return sent;
  }

  launchNapcat(launcher?: string, qq?: string): { launched: boolean; detail: string } {
    const file = (launcher ?? this.settings.napcatLauncher ?? '').trim();
    if (!file) throw new Error('请先填写 NapCat 启动脚本路径（如 launcher-user.bat）。');
    if (!existsSync(file)) throw new Error(`找不到 NapCat 启动文件：${file}`);
    const qqNum = (qq ?? this.settings.napcatQq ?? '').trim();
    const args = qqNum ? ['-q', qqNum] : [];
    const cwd = path.dirname(file);
    // Strip Electron/Node worker env vars AND restore the real Windows user profile if Start-FountAIn.cmd
    // redirected USERPROFILE/APPDATA to an isolated profile directory (so QQ finds its saved login session!).
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (/^(ELECTRON_|NODE_OPTIONS$|NODE_ENV$|FOUNTAIN_|FOUNTAIN_|CHROME_)/i.test(key)) {
        delete cleanEnv[key];
      }
    }
    if (process.platform === 'win32') {
      const desktopRoot = process.env.FOUNTAIN_DESKTOP_ROOT;
      const matchHome = file.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i)?.[0];
      const realHome =
        (desktopRoot && existsSync(path.dirname(desktopRoot)) ? path.dirname(desktopRoot) : undefined) ||
        (matchHome && existsSync(matchHome) ? matchHome : undefined);
      if (realHome) {
        cleanEnv.USERPROFILE = realHome;
        cleanEnv.HOME = realHome;
        cleanEnv.APPDATA = path.join(realHome, 'AppData', 'Roaming');
        cleanEnv.LOCALAPPDATA = path.join(realHome, 'AppData', 'Local');
        cleanEnv.TEMP = path.join(realHome, 'AppData', 'Local', 'Temp');
        cleanEnv.TMP = path.join(realHome, 'AppData', 'Local', 'Temp');
      }
      // Use wscript.exe + WScript.Shell.Run(..., 0, False) so SW_HIDE suppresses any child console window completely!
      const vbsPath = path.join(cleanEnv.TEMP || os.tmpdir(), 'fountain-launch-napcat.vbs');
      const vbsEsc = (s: string) => s.replace(/"/g, '""');
      const cmdStr = `""${vbsEsc(file)}""${qqNum ? ` -q ${vbsEsc(qqNum)}` : ''}`;
      const vbsContent = [
        'Set sh = CreateObject("WScript.Shell")',
        `sh.CurrentDirectory = "${vbsEsc(cwd)}"`,
        `sh.Run "${cmdStr}", 0, False`,
        '',
      ].join('\r\n');
      writeFileSync(vbsPath, vbsContent, 'utf8');
      const child = spawn('wscript.exe', [vbsPath], { cwd, env: cleanEnv, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { launched: true, detail: `已在后台静默启动 NapCat（${path.basename(file)}），等待自动登录连入端口 ${this.settings.port}。` };
    }
    const isBatch = /\.(bat|cmd)$/i.test(file);
    const child = isBatch
      ? spawn('cmd.exe', ['/c', file, ...args], { cwd, env: cleanEnv, detached: true, stdio: 'ignore', windowsHide: true })
      : spawn(file, args, { cwd, env: cleanEnv, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { launched: true, detail: `已启动 NapCat（${path.basename(file)}），请等待几秒自动连上端口 ${this.settings.port}。` };
  }
}
