// The activity log: who signed in (or failed to), changed accounts or settings, shared or deleted
// files. Newest first, filtered by kind, words and dates, a page at a time, or downloaded as CSV.
import { useCallback, useEffect, useState } from 'react';
import { get } from '../../api.js';
import { Empty, useToast } from '../../components/ui.jsx';

const KINDS = [
  ['', 'All activity'],
  ['sign-in,sign-out,session,password,2fa,mail-app,passkey,recovery,api_token', 'Sign-ins and security'],
  ['sign-in.failed', 'Failed sign-ins'],
  ['mail.phishing,mail.blocked,mail.unblocked,mail.swept,dlp', 'Phishing and data protection'],
  ['user', 'People'],
  ['company,domain,alias', 'Company and mail settings'],
  ['file,link,trash', 'Files and sharing'],
];
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const dayStart = (s) => (s ? new Date(`${s}T00:00`).getTime() : '');

/** Details in words: "with: a@x (viewer)", "is_admin: false". */
function detailText(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.entries(d).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') || 'nobody' : typeof v === 'object' && v ? JSON.stringify(v) : String(v)}`).join(' · ');
}

export default function ActivityAdmin({ orgId, orgPicker, initialKind = '' }) {
  const toast = useToast();
  const [kind, setKind] = useState(KINDS.some(([v]) => v === initialKind) ? initialKind : ''); // the security checkup can open it filtered
  const [text, setText] = useState('');
  const [words, setWords] = useState(''); // what was searched (applied after a pause)
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { const t = setTimeout(() => setWords(text.trim()), 300); return () => clearTimeout(t); }, [text]);

  const params = useCallback((extra = {}) => {
    const p = new URLSearchParams();
    if (orgId) p.set('org_id', orgId);
    if (kind) p.set('action', kind);
    if (words) p.set('q', words);
    if (from) p.set('from', dayStart(from));
    if (to) p.set('to', dayStart(to) + 864e5); // through the end of that day
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  }, [orgId, kind, words, from, to]);

  useEffect(() => {
    let live = true;
    setBusy(true);
    get(`/audit?${params()}`).then((d) => { if (live) { setEntries(d.entries); setMore(d.more); } })
      .catch((e) => toast(e.message, 'error')).finally(() => live && setBusy(false));
    return () => { live = false; };
  }, [params, toast]);

  async function loadMore() {
    setBusy(true);
    try {
      const d = await get(`/audit?${params({ before: entries[entries.length - 1].id })}`);
      setEntries((list) => [...list, ...d.entries]);
      setMore(d.more);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  const filtered = kind || words || from || to;
  return (
    <div className="stack" style={{ maxWidth: 1100 }}>
      {orgPicker}
      <div className="card stack">
        <div className="row wrap" style={{ gap: 8 }}>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of activity">
            {KINDS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search people, files, addresses" aria-label="Search activity" style={{ minWidth: 220 }} />
          <label className="row small muted" style={{ gap: 4 }}>From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" /></label>
          <label className="row small muted" style={{ gap: 4 }}>To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" /></label>
          {filtered && <button type="button" className="link-btn small" onClick={() => { setKind(''); setText(''); setFrom(''); setTo(''); }}>Clear filters</button>}
          <span className="grow" />
          <a className="btn" href={`/api/audit/export?${params()}`} download>Download CSV</a>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Sign-ins, changes to people and settings, sharing and deleting files. Times are in your time zone; entries are kept for a year.
        </p>
      </div>

      {entries === null ? null : entries.length === 0 ? (
        <Empty icon="clock" title={filtered ? 'Nothing matches' : 'No activity yet'}>{filtered ? 'Try other filters.' : 'Sign-ins and changes will show up here.'}</Empty>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table className="files activity" aria-busy={busy}>
            <thead><tr><th>When</th><th>Who</th><th>What</th><th className="hide-sm">Details</th><th className="hide-sm">IP address</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="muted nowrap">{when(e.at)}</td>
                  <td>{e.actor_name || <span className="muted">Someone not signed in</span>}</td>
                  <td>
                    <span className={['sign-in.failed', 'mail.phishing', 'dlp.blocked'].includes(e.action) ? 'pill warn' : undefined}>{e.label}</span>
                    {e.target && <> <strong>{e.target}</strong></>}
                  </td>
                  <td className="hide-sm muted small">{detailText(e.details)}</td>
                  <td className="hide-sm muted small nowrap">{e.ip || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {more && <div className="row" style={{ justifyContent: 'center', padding: 12 }}><button type="button" className="btn" disabled={busy} onClick={loadMore}>Load more</button></div>}
        </div>
      )}
    </div>
  );
}
