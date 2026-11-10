import { useEffect, useState } from 'react';
import { get, put, post, patch, del } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';

const KEEP = [['inbox', 'keep Workspace’s copy in the Inbox'], ['read', 'mark Workspace’s copy as read'], ['archive', 'archive Workspace’s copy'], ['trash', 'move Workspace’s copy to the Trash']];

/** Forwarding all incoming mail to another address, once that address confirms with a code. */
export function ForwardingDialog({ onClose, onChanged }) {
  const toast = useToast();
  const [f, setF] = useState(null);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/mail/forwarding').then(setF).catch((e) => toast(e.message, 'error')); }, [toast]);
  const run = async (fn, msg) => {
    setBusy(true);
    try { const next = await fn(); setF(next); onChanged?.(next); if (msg) toast(typeof msg === 'function' ? msg(next) : msg); return next; }
    catch (e) { toast(e.message, 'error'); return null; }
    finally { setBusy(false); }
  };
  const sendCode = async (e) => {
    e.preventDefault();
    const next = await run(() => put('/mail/forwarding', { address }), (n) => (n.confirmed ? 'Forwarding address kept' : `A confirmation code was sent to ${n.address}`));
    if (next) { setChanging(false); setCode(''); }
  };
  if (!f) return <Modal title="Forwarding" onClose={onClose}><p className="muted">Loading…</p></Modal>;
  const addressForm = (
    <form onSubmit={sendCode} className="stack">
      <label className="field">
        <span>Forward a copy of all incoming mail to</span>
        <input type="email" required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="name@example.com" autoFocus />
      </label>
      {!f.allowed_outside && <p className="muted small" style={{ margin: 0 }}>Your company only allows forwarding to its own addresses.</p>}
      <p className="muted small" style={{ margin: 0 }}>A code is sent there first: forwarding starts once you type it here, so mail only goes to an address that agreed to it.</p>
      <div className="row"><button className="btn primary" disabled={busy || !address.trim()}>Send confirmation code</button>
        {changing && <button type="button" className="btn" onClick={() => setChanging(false)}>Cancel</button>}</div>
    </form>
  );
  let body;
  if (!f.address || changing) body = addressForm;
  else if (!f.confirmed) {
    body = (
      <div className="stack">
        <p style={{ margin: 0 }}>A confirmation code was sent to <strong>{f.address}</strong>. Type it here to start forwarding.</p>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => post('/mail/forwarding/confirm', { code }), (n) => `Mail is now forwarded to ${n.address}`)) setCode(''); }}>
          <input aria-label="Confirmation code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" style={{ width: 120 }} autoFocus />
          <button className="btn primary" disabled={busy || code.replace(/\D/g, '').length !== 6}>Confirm</button>
        </form>
        <div className="row">
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => post('/mail/forwarding/resend'), 'A new code was sent')}>Send a new code</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => { setAddress(''); setChanging(true); }}>Use another address</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => del('/mail/forwarding'), 'Forwarding removed')}>Remove</button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="stack">
        {f.blocked && <div className="banner warn" role="status">Your company no longer allows forwarding outside it, so nothing goes to {f.address}.</div>}
        <label className="check">
          <input type="checkbox" checked={f.enabled} disabled={busy} onChange={(e) => run(() => patch('/mail/forwarding', { enabled: e.target.checked }), (n) => (n.enabled ? `Mail is forwarded to ${n.address}` : 'Forwarding is off'))} />
          <span>Forward a copy of incoming mail to <strong>{f.address}</strong></span>
        </label>
        <label className="field">
          <span>and</span>
          <select aria-label="Workspace’s copy" value={f.keep} disabled={busy} onChange={(e) => run(() => patch('/mail/forwarding', { keep: e.target.value }), 'Saved')}>
            {KEEP.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        <p className="muted small" style={{ margin: 0 }}>The mail server does it as mail arrives, so it works while Workspace is closed. Spam isn't forwarded. Forwarded mail keeps its original sender; some receiving services treat forwarded mail from other domains with suspicion.</p>
        <div className="row">
          <button type="button" className="btn small" onClick={() => { setAddress(''); setChanging(true); }}>Change address</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => del('/mail/forwarding'), 'Forwarding removed')}>Remove forwarding</button>
        </div>
      </div>
    );
  }
  return <Modal title="Forwarding" onClose={onClose}>{body}</Modal>;
}
