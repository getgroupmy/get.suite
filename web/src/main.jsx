import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { onLive, reconnectNow } from './api.js';
import './styles.css';

// Without a connection: say so (the app itself still opens, from the service worker). With the network up but the
// server out of reach (restarting for an update, the proxy down) for more than a few seconds: say that too, with
// Try now, instead of letting things fail quietly. Coming back online or to the tab tries again at once.
const SERVER_GRACE_MS = 4000;
function OfflineBar() {
  const [online, setOnline] = useState(navigator.onLine);
  const [unreachable, setUnreachable] = useState(false);
  const [saved, setSaved] = useState(null); // what's shown came from this device (api.js), last fetched then
  useEffect(() => {
    const got = (e) => setSaved((t) => Math.min(t || Infinity, e.detail?.at || Date.now()));
    window.addEventListener('nw:offline-data', got);
    return () => window.removeEventListener('nw:offline-data', got);
  }, []);
  useEffect(() => { if (online && !unreachable) setSaved(null); }, [online, unreachable]);
  const note = saved ? ` Showing what was last saved on this device (${new Date(saved).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}).` : '';
  useEffect(() => {
    const on = () => { setOnline(true); reconnectNow(); }, off = () => setOnline(false);
    const back = () => { if (document.visibilityState === 'visible') reconnectNow(); };
    window.addEventListener('online', on); window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', back);
    let wait = null;
    const stop = onLive((m) => {
      if (m.type === 'live-disconnected') { if (!wait) wait = setTimeout(() => setUnreachable(true), SERVER_GRACE_MS); }
      else if (m.type === 'live-connected') { clearTimeout(wait); wait = null; setUnreachable(false); }
    });
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); document.removeEventListener('visibilitychange', back); stop(); clearTimeout(wait); };
  }, []);
  if (!online) return <div className="offline-bar" role="status">You're offline. Workspace reconnects by itself when the network is back.{note}</div>;
  if (unreachable) return <div className="offline-bar" role="status">Can't reach Workspace right now. Reconnecting…{note} <button type="button" className="link-btn" onClick={reconnectNow}>Try now</button></div>;
  return null;
}

createRoot(document.getElementById('root')).render(<StrictMode><OfflineBar /><App /></StrictMode>);

// Installable as an app (and opens without a connection): see public/sw.js.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  // Tell it which app files are loaded (now and as more load), so they're kept for opening offline.
  const tell = (urls) => { if (urls.length) navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'keep-assets', urls })).catch(() => {}); };
  const assets = (list) => list.map((e) => e.name).filter((u) => u.includes('/assets/'));
  window.addEventListener('load', () => tell(assets(performance.getEntriesByType('resource'))));
  try { new PerformanceObserver((l) => tell(assets(l.getEntries()))).observe({ type: 'resource', buffered: false }); } catch { /* older browsers */ }
}
