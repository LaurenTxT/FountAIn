import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { phoneHud } from '../shared/desktop-hud';

const LIFETIME = 15 * 60_000;
const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>FountAIn 状态</title><h1>FountAIn 状态</h1><p id="state" role="status">正在连接</p><main id="rows"></main><script src="/status.js"></script></html>';
const css = 'body{font:16px system-ui,sans-serif;background:#201b17;color:#f5eadc;max-width:38rem;margin:auto;padding:1rem}h1{font-size:1.35rem}main{display:grid;gap:.65rem}article{padding:.75rem;border:1px solid #6f5c4d;border-radius:.5rem}article p{margin:.35rem 0 0;color:#dcc9b6}';
const script = `
const key = location.hash.slice(1);
history.replaceState(null, '', '/');
const state = document.querySelector('#state');
const rows = document.querySelector('#rows');
async function poll() {
  if (!key) { state.textContent = '请使用电脑显示的完整链接。'; return; }
  try {
    const response = await fetch('/status', { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' });
    if (!response.ok) { rows.replaceChildren(); state.textContent = '链接已失效，请从电脑重新开启。'; return; }
    const data = await response.json();
    rows.replaceChildren(...data.map(item => {
      const card = document.createElement('article');
      const name = document.createElement('strong'); name.textContent = item.executor + ' · ' + item.state;
      const stats = document.createElement('p'); stats.textContent = item.quota + ' · ' + (item.tokens === undefined ? 'Token 未回报' : '最近一轮 ' + item.tokens.toLocaleString() + ' Token');
      card.append(name, stats); return card;
    }));
    state.textContent = '只读 · ' + (response.headers.get('X-FountAIn-Attention') ?? '0') + ' 项待处理 · ' + new Date().toLocaleTimeString();
  } catch { rows.replaceChildren(); state.textContent = '暂未连接电脑。'; }
  setTimeout(poll, 3500);
}
poll();`;

function privateAddresses() {
  return Object.values(networkInterfaces()).flatMap(items => items ?? []).filter(item =>
    !item.internal && item.family === 'IPv4' && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address));
}

export class HudPhoneServer {
  private server?: Server;
  private timer?: NodeJS.Timeout;

  async start(read: () => ReturnType<typeof phoneHud>, attention = () => 0) {
    this.stop();
    const local = privateAddresses();
    if (!local.length) throw new Error('没有可用的局域网地址，请先连接同一 Wi-Fi。');
    const key = randomBytes(24).toString('base64url');
    const expected = Buffer.from('Bearer ' + key);
    const endpoints = new Map([['/', ['text/html', html]], ['/style.css', ['text/css', css]], ['/status.js', ['text/javascript', script]]]);
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      const address = req.socket.remoteAddress;
      if (!address || !local.some(item => sameSubnet(address, item.address, item.netmask))) { res.writeHead(403).end(); return; }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (req.url === '/status') {
        const actual = Buffer.from(req.headers.authorization ?? '');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(401).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-FountAIn-Attention': String(attention()) }).end(JSON.stringify(read()));
        return;
      }
      const asset = endpoints.get(req.url ?? '');
      if (!asset) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': asset[0] + '; charset=utf-8' }).end(asset[1]);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', resolve);
      });
    } catch (error) {
      if (this.server === server) this.stop();
      throw error;
    }
    if (this.server !== server) throw new Error('手机入口已关闭。');
    const port = (server.address() as { port: number }).port;
    this.timer = setTimeout(() => this.stop(), LIFETIME);
    this.timer.unref();
    return { links: [...new Set(local.map(item => 'http://' + item.address + ':' + port + '/#' + key))], expiresAt: Date.now() + LIFETIME };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }
}

function sameSubnet(client: string, server: string, mask: string): boolean {
  const ipv4 = client.replace(/^::ffff:/, '');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) return false;
  const parts = ipv4.split('.').map(Number), network = server.split('.').map(Number);
  return parts.length === 4 && mask.split('.').map(Number).every((part, index) =>
    (parts[index] & part) === (network[index] & part));
}
