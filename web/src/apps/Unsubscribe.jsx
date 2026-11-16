// The page an unsubscribe link in a mail merge email opens (/u/<token>, no account): who the emails are from,
// and a button to stop them. Opening the page changes nothing (link checkers in mail apps open links too).
import { useEffect, useState } from 'react';

async function call(method, token) {
  const res = await fetch(`/api/public/unsubscribe/${encodeURIComponent(token)}`, { method, headers: { 'x-requested-with': 'nas-workspace' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export default function Unsubscribe({ token }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('GET', token).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  let body;
  if (error && !info) body = <div className="link-msg" role="alert"><h1>Link not found</h1><p className="muted">{error}</p></div>;
  else if (!info) body = <p className="muted">Loading…</p>;
  else body = (
    <section className="invite-card stack" aria-live="polite">
      <h1>{info.left ? 'You’re unsubscribed' : 'Unsubscribe'}</h1>
      {info.left
        ? <p>{info.from} won’t send more of these emails to <strong>{info.email}</strong>.</p>
        : <>
          <p>Stop getting emails like this from <strong>{info.from}</strong> at <strong>{info.email}</strong>?</p>
          <div className="row"><button type="button" className="btn primary" disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try { await call('POST', token); setInfo({ ...info, left: true }); } catch (e) { setError(e.message); }
            setBusy(false);
          }}>Unsubscribe</button></div>
        </>}
      {error && <p className="error small" role="alert">{error}</p>}
    </section>
  );
  return (
    <div className="link-page">
      <header className="link-head"><div className="brand"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div></header>
      <main className="link-main">{body}</main>
    </div>
  );
}
