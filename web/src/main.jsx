import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Without a connection: say so (the app itself still opens, from the service worker).
function OfflineBar() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online ? null : <div className="offline-bar" role="status">You're offline. Workspace reconnects by itself when the network is back.</div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><OfflineBar /><App /></StrictMode>);

// Installable as an app (and opens without a connection): see public/sw.js.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
