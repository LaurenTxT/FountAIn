import { useEffect, useState } from 'react';
import { Activity, ExternalLink, Smartphone, X } from 'lucide-react';
import { useHudSnapshot } from './use-hud-snapshot';
import './desktop-hud.css';

interface PhoneLink { links: string[]; expiresAt: number }

export function DesktopHud() {
  const status = useHudSnapshot();
  const rows = status?.rows;
  const [phone, setPhone] = useState<PhoneLink>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bridge = window.fountain;
  useEffect(() => {
    if (!phone) return;
    const timer = window.setTimeout(() => setPhone(undefined), Math.max(0, phone.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [phone]);

  async function togglePhone() {
    setBusy(true);
    setError('');
    try {
      if (phone) { await bridge.invoke('hud.phone.stop'); setPhone(undefined); }
      else setPhone(await bridge.invoke<PhoneLink>('hud.phone.start'));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function usageAction(method: 'hud.agy.open' | 'hud.billing.refresh') {
    setBusy(true);
    setError('');
    try { await bridge.invoke(method); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  function focus(sessionId?: string) { void bridge.invoke('hud.focus', { sessionId }).catch(error => setError(error.message)); }
  return <main className="desktop-hud">
    <header className="desktop-hud-header">
      <Activity size={17} /><h1>FountAIn 桌面浮层</h1>
      <button type="button" className="icon-button" aria-label="打开工作台" onClick={() => focus()}><ExternalLink size={15} /></button>
      <button type="button" className="icon-button" aria-label="关闭桌面浮层" onClick={() => void bridge.invoke('hud.close')}><X size={17} /></button>
    </header>
    <div className="desktop-hud-rows">
      {status && status.attention > 0 && <p role="status">{status.attention} 项待处理</p>}
      {!rows?.length && <p role="status">{rows ? '暂无 FountAIn 成员数据。' : '正在获取状态…'}</p>}
      {rows?.map(row => <article key={row.name + row.executor} className="desktop-hud-row">
        <header className="desktop-hud-row-heading"><div><strong>{row.name}</strong><small>{row.executor}</small></div><span>{row.state}</span></header>
        <dl className="desktop-hud-metrics">
          {(row.usageMetrics ?? [{ label: '额度', value: row.quota }]).map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}
          <div><dt>最近一轮 Token</dt><dd>{row.tokens === undefined ? '未回报' : row.tokens.toLocaleString()}</dd></div>
        </dl>
        {row.usageDetail && <details className="desktop-hud-source"><summary>数据来源与更新时间</summary><small>{row.usageDetail}</small></details>}
        <div className="desktop-hud-row-actions">
          {row.usageProvider === 'agy' && <button type="button" className="link-button" aria-label="刷新 Antigravity 额度" disabled={busy} onClick={() => void usageAction('hud.agy.open')}>刷新额度</button>}
          {row.usageProvider === 'claude' && status?.apiRelay && <button type="button" className="link-button" aria-label="查询 API 实际扣费" disabled={busy} onClick={() => void usageAction('hud.billing.refresh')}>刷新扣费</button>}
          {row.session && <button type="button" className="link-button" title={row.session} onClick={() => focus(row.sessionId)}>打开会话</button>}
        </div>
      </article>)}
    </div>
    <footer>
      {phone?.links.map(link => <label key={link} className="desktop-hud-link"><span>手机浏览器链接</span><input readOnly value={link} onFocus={event => event.currentTarget.select()} /></label>)}
      {phone && <small>同一局域网可访问，15 分钟后失效。链接请勿转发。</small>}
      {error && <p role="alert">{error}</p>}
      <button type="button" className="button small secondary" disabled={busy} onClick={() => void togglePhone()}><Smartphone size={14} />{phone ? '关闭手机只读入口' : '开启手机只读入口'}</button>
    </footer>
  </main>;
}
