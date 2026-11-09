// Admin → System (platform owner): is everything all right on this NAS? Disk space, the daily
// database snapshots, the mail server and its certificate, and how big things are. The same checks
// run every hour, and the platform owners are notified when one needs attention.
import { useCallback, useEffect, useState } from 'react';
import { get, post, formatBytes } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, useToast } from '../../components/ui.jsx';

const WORD = { ok: 'OK', warn: 'Check soon', bad: 'Needs attention' };
const SUMMARY = { ok: 'Everything looks fine', warn: 'Something should be looked at soon', bad: 'Something needs attention' };

export default function SystemAdmin() {
  const toast = useToast();
  const [h, setH] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setBusy(true); get('/orgs/system/health').then(setH).catch((e) => toast(e.message, 'error')).finally(() => setBusy(false)); }, [toast]);
  useEffect(load, [load]);
  if (!h) return <p className="muted">Checking…</p>;
  const f = h.facts;
  const facts = [
    ['Version', f.version || '—'], ['Node.js', f.node], ['Running since', new Date(f.up_since).toLocaleString()],
    ['Database', formatBytes(f.database_bytes)], ['Files', formatBytes(f.files_bytes)], ['Database snapshots', formatBytes(f.backups_bytes)],
    ['Companies', f.companies], ['People', f.people],
  ];
  return (
    <div className="stack" style={{ maxWidth: 800 }}>
      <div className="card row" role="status" aria-label="Overall health">
        <span className={`health-dot ${h.status}`} aria-hidden="true" />
        <div className="grow"><strong>{SUMMARY[h.status]}</strong>
          <div className="muted small">Checked {new Date(h.checked_at).toLocaleTimeString()}. Checked every hour too: you’re notified when something needs attention.</div></div>
        <button className="btn" onClick={load} disabled={busy}><Icon name="check" /> Check again</button>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <ul className="health-list" aria-label="Checks">
          {h.checks.map((c) => (
            <li key={c.id} className="row" aria-label={c.label}>
              <span className={`health-dot ${c.status}`} aria-hidden="true" />
              <div className="grow"><strong>{c.label}</strong><div className="muted small">{c.detail}</div></div>
              <span className={`pill health-${c.status}`}>{WORD[c.status]}</span>
            </li>
          ))}
        </ul>
      </div>
      <MailQueue onChanged={load} />
      <Snapshots onTaken={load} />
      <div className="card">
        <h3 style={{ marginTop: 0 }}>This server</h3>
        <dl className="health-facts">{facts.map(([k, v]) => <div key={k}><dt className="muted small">{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
    </div>
  );
}

// The daily database snapshots kept on the NAS: take one now (before an update, say) and download
// one, to keep a copy somewhere else. A snapshot holds everything but uploaded files and mail.
function Snapshots({ onTaken }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(null); // the snapshot asked about
  const [typed, setTyped] = useState('');
  const [restarting, setRestarting] = useState(false);
  // Back after the restart: reload, which signs in again if the snapshot is from before this sign-in.
  useEffect(() => {
    if (!restarting) return undefined;
    let gone = false;
    const t = setInterval(async () => {
      try { const r = await fetch('/api/auth/status', { cache: 'no-store' }); if (r.ok && gone) window.location.reload(); if (!r.ok) gone = true; } catch { gone = true; }
    }, 1500);
    return () => clearInterval(t);
  }, [restarting]);
  useEffect(() => { get('/orgs/system/backups').then(setList).catch((e) => toast(e.message, 'error')); }, [toast]);
  const take = async () => {
    setBusy(true);
    try { setList(await post('/orgs/system/backups')); toast('Snapshot taken'); onTaken(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card stack">
      <div className="row"><h3 className="grow" style={{ margin: 0 }}>Database snapshots</h3>
        <button className="btn" onClick={take} disabled={busy}><Icon name="restore" /> {busy ? 'Taking…' : 'Take a snapshot now'}</button></div>
      <p className="muted small" style={{ margin: 0 }}>One is written every day and the last 7 are kept, in <code>data/backups</code>. Each holds companies, people, documents, calendars, contacts and chat (not uploaded files or mail), including passwords’ hashes and mail-signing keys: keep downloaded copies somewhere safe. Taking one today replaces today’s.</p>
      {restarting && <div className="banner" role="status">Restoring {restarting}: Workspace is restarting with it, which takes a minute. This page reloads when it's back.</div>}
      {list === null ? <p className="muted">Loading…</p> : !list.length ? <p className="muted" style={{ margin: 0 }}>None yet.</p> : (
        <ul className="health-list" aria-label="Snapshots">
          {list.map((b) => (
            <li key={b.name} className="row" aria-label={b.name}>
              <Icon name="file" />
              <div className="grow">{b.name}<div className="muted small">{new Date(b.at).toLocaleString()} · {formatBytes(b.size)}</div></div>
              <a className="btn" href={`/api/orgs/system/backups/${encodeURIComponent(b.name)}`} download aria-label={`Download ${b.name}`}><Icon name="download" /> Download</a>
              <button className="btn" onClick={() => { setTyped(''); setRestoring(b); }} aria-label={`Restore ${b.name}`}>Restore…</button>
            </li>
          ))}
        </ul>
      )}
      {restoring && (
        <ConfirmModal title={`Restore ${restoring.name}?`} confirm="Restore and restart" onClose={() => setRestoring(null)}
          message={`Everything goes back to how it was on ${new Date(restoring.at).toLocaleString()}: changes since then to people, documents, calendars, contacts and chat are undone, and everyone may need to sign in again. Files uploaded since stay on the NAS but aren't listed; files deleted since can't come back. The database as it is now is kept as a snapshot, so this can be undone.`}
          onConfirm={async () => {
            const date = restoring.name.match(/\d{4}-\d{2}-\d{2}/)[0];
            if (typed.trim() !== date) throw new Error(`Type ${date} to confirm`);
            const r = await post(`/orgs/system/backups/${encodeURIComponent(restoring.name)}/restore`, { confirm: restoring.name });
            if (r.restarting) setRestarting(restoring.name); else toast('The snapshot goes back in place the next time Workspace starts');
          }}>
          <label className="field"><span>Type the snapshot’s date ({restoring.name.match(/\d{4}-\d{2}-\d{2}/)[0]}) to confirm</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></label>
        </ConfirmModal>
      )}
    </div>
  );
}

// Mail waiting to go out: the mail server retries for up to five days before returning it to the
// sender. Retry (after fixing what's wrong) or delete a message; each request is carried out by the
// mail server within a few seconds.
const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `${Math.max(1, m)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
function MailQueue({ onChanged }) {
  const toast = useToast();
  const [qd, setQd] = useState(null);
  const [pending, setPending] = useState(null); // a request's number, until carried out
  const [deleting, setDeleting] = useState(null);
  const load = useCallback(() => get('/orgs/system/mail-queue').then(setQd).catch(() => setQd({ available: false })), []);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]); // the mail server reports every few seconds
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(async () => {
      const r = await get('/orgs/system/mail-queue').catch(() => null);
      if (r) setQd(r);
      if (r?.done >= pending) { setPending(null); onChanged(); }
    }, 1500);
    return () => clearInterval(t);
  }, [pending, onChanged]);
  if (!qd || qd.reason === 'no-mail') return null;
  const ask = async (op, id, msg) => {
    try { const { seq } = await post('/orgs/system/mail-queue', { op, id }); setPending(seq); toast(msg); } catch (e) { toast(e.message, 'error'); }
  };
  const waiting = qd.available ? qd.messages : [];
  return (
    <div className="card stack">
      <div className="row"><h3 className="grow" style={{ margin: 0 }}>Outgoing mail queue</h3>
        {waiting.length > 0 && <button className="btn" disabled={!!pending} onClick={() => ask('flush', null, 'Retrying everything')}><Icon name="send" /> Retry all</button>}</div>
      {!qd.available ? (
        <p className="muted small" style={{ margin: 0 }}>{qd.reason === 'not-set-up'
          ? 'Not set up: give both containers the mail-status folder (see docker-compose.yml) to see mail waiting to go out here.'
          : 'The mail server hasn’t reported its queue yet: it does every few seconds once it’s running with the mail-status folder.'}</p>
      ) : !waiting.length ? <p className="muted" style={{ margin: 0 }}>Nothing waiting to go out.</p> : (
        <>
          <p className="muted small" style={{ margin: 0 }}>Mail the other side didn’t take yet. The mail server keeps trying for five days, then returns it to the sender. {pending ? 'Asking the mail server…' : ''}</p>
          <ul className="health-list" aria-label="Waiting to go out">
            {waiting.map((m) => (
              <li key={m.id} className="row" aria-label={`${m.sender || 'System'} to ${m.recipients.map((r) => r.address).join(', ')}`}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong>{m.recipients.map((r) => r.address).join(', ')}</strong> <span className="muted small">from {m.sender || 'the system'} · {ago(m.arrived)} · {formatBytes(m.size)}{m.queue === 'hold' ? ' · on hold' : m.queue === 'active' ? ' · sending now' : ''}</span>
                  {m.recipients.filter((r) => r.reason).map((r) => <div key={r.address} className="muted small" style={{ overflowWrap: 'anywhere' }}>{r.reason}</div>)}
                </div>
                <button className="btn" disabled={!!pending} onClick={() => ask('retry', m.id, 'Retrying')}>Retry</button>
                <button className="btn danger" disabled={!!pending} onClick={() => setDeleting(m)} aria-label={`Delete message to ${m.recipients.map((r) => r.address).join(', ')}`}>Delete</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {deleting && <ConfirmModal title="Delete this message?" message={`To ${deleting.recipients.map((r) => r.address).join(', ')}: it won’t be delivered, and the sender isn’t told.`}
        onConfirm={() => ask('delete', deleting.id, 'Deleting')} onClose={() => setDeleting(null)} />}
    </div>
  );
}
