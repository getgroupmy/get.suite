// Admin → System (platform owner): is everything all right on this NAS? Disk space, the daily
// database snapshots, the mail server and its certificate, and how big things are. The same checks
// run every hour, and the platform owners are notified when one needs attention.
import { useCallback, useEffect, useState } from 'react';
import { get, post, formatBytes } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { useToast } from '../../components/ui.jsx';

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
      {list === null ? <p className="muted">Loading…</p> : !list.length ? <p className="muted" style={{ margin: 0 }}>None yet.</p> : (
        <ul className="health-list" aria-label="Snapshots">
          {list.map((b) => (
            <li key={b.name} className="row" aria-label={b.name}>
              <Icon name="file" />
              <div className="grow">{b.name}<div className="muted small">{new Date(b.at).toLocaleString()} · {formatBytes(b.size)}</div></div>
              <a className="btn" href={`/api/orgs/system/backups/${encodeURIComponent(b.name)}`} download aria-label={`Download ${b.name}`}><Icon name="download" /> Download</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
