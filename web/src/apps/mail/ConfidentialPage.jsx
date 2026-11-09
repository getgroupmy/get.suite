// Reading a confidential message (/c/<link>): signed in as one of its recipients it opens straight
// away; anyone else it was sent to types their address, gets a code by email, and types it. No
// forward, download or print here; it stops working when it expires or the sender takes it back.
import { useEffect, useState } from 'react';

const call = async (method, url, body) => {
  const r = await fetch(`/api/public/confidential/${url}`, { method, credentials: 'same-origin', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};
const until = (t) => new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export default function ConfidentialPage({ token, onSignIn }) {
  const [m, setM] = useState(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { document.title = 'Confidential message'; call('GET', encodeURIComponent(token)).then(setM).catch((e) => setError(e.message)); }, [token]);
  const ask = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await call('POST', `${encodeURIComponent(token)}/code`, { email }); setAsked(true); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const open = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try { setM(await call('POST', `${encodeURIComponent(token)}/open`, { email, code })); } catch (err) { setError(err.message); }
    setBusy(false);
  };
  const readable = m && (m.html || m.text) !== undefined && !m.need;
  return (
    <div className="link-page confidential-page" onCopy={(e) => readable && e.preventDefault()} onContextMenu={(e) => readable && e.preventDefault()}>
      <header className="link-head"><div className="brand"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div></header>
      <main className="link-main"><div className="card stack" style={{ padding: 20 }}>
        <p className="muted small" style={{ margin: 0 }}>🔒 Confidential message</p>
        {!m && error && <p className="error" role="alert">{error}</p>}
        {!m && !error && <p className="muted">Loading…</p>}
        {m && <>
          <h1 style={{ margin: 0 }}>{m.subject || '(No subject)'}</h1>
          <p className="muted small" style={{ margin: 0 }}>From {m.from?.name}{m.from?.address ? ` <${m.from.address}>` : ''} · readable until {until(m.expires_at)}</p>
        </>}
        {readable && (m.html
          ? <iframe className="mail-html confidential-body" title="Message" sandbox="" srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1f1f1f;background:#fff;user-select:none;-webkit-user-select:none}@media print{body{display:none}}</style></head><body>${m.html}</body></html>`} style={{ width: '100%', minHeight: 300, border: 0 }} />
          : <div className="confidential-body" style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>)}
        {readable && <p className="muted small" style={{ margin: 0 }}>This message can't be forwarded, downloaded or printed from here.{m.mine ? ' You sent it: take it back from Mail → Confidential messages.' : ''}</p>}
        {m?.need === 'code' && (!asked ? (
          <form className="stack-tight" onSubmit={ask}>
            <p style={{ margin: 0 }}>{m.from?.name} sent this to you by email. To read it, type your email address: a code is sent there.</p>
            <label className="field"><span>Your email address</span><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
            <div className="row"><button type="submit" className="btn primary" disabled={busy}>Send me a code</button>
              <span className="muted small grow">Colleagues: <button type="button" className="link-btn" onClick={onSignIn}>sign in</button> to read it straight away.</span></div>
          </form>
        ) : (
          <form className="stack-tight" onSubmit={open}>
            <p style={{ margin: 0 }}>If this was sent to <strong>{email}</strong>, a code is on its way there. It works for 10 minutes.</p>
            <label className="field"><span>Code</span><input inputMode="numeric" autoComplete="one-time-code" required maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
            <div className="row"><button type="submit" className="btn primary" disabled={busy || code.length !== 6}>Read the message</button>
              <button type="button" className="btn" onClick={() => { setAsked(false); setCode(''); }}>Use another address</button></div>
          </form>
        ))}
        {m && error && <p className="error" role="alert">{error}</p>}
      </div></main>
    </div>
  );
}
