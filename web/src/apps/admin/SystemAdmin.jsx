// Admin → System (platform owner): is everything all right on this NAS? Disk space, the daily
// database snapshots, the mail server and its certificate, and how big things are. The same checks
// run every hour, and the platform owners are notified when one needs attention.
import { useCallback, useEffect, useState } from 'react';
import { get, formatBytes } from '../../api.js';
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
      <div className="card">
        <h3 style={{ marginTop: 0 }}>This server</h3>
        <dl className="health-facts">{facts.map(([k, v]) => <div key={k}><dt className="muted small">{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
    </div>
  );
}
