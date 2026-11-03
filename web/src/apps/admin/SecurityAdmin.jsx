import { useCallback, useEffect, useState } from 'react';
import { get, put, del } from '../../api.js';
import { Empty, useToast } from '../../components/ui.jsx';

const SERVICE = { web: 'Workspace', imap: 'Mail app (IMAP)', smtp: 'Mail app (SMTP)', submission: 'Mail app (SMTP)' };
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

export default function SecurityAdmin() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [allow, setAllow] = useState('');
  const load = useCallback(() => get('/security').then((d) => { setData(d); setAllow(d.allowlist.join('\n')); }).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  if (!data) return null;
  const { limits } = data;

  async function unblock(ip) {
    try { await del(`/security/bans/${encodeURIComponent(ip)}`); toast(`${ip} unblocked`); load(); } catch (e) { toast(e.message, 'error'); }
  }
  async function saveAllow(e) {
    e.preventDefault();
    try { await put('/security/allowlist', { entries: allow.split(/[\s,]+/).filter(Boolean) }); toast('Allowlist saved'); load(); }
    catch (err) { toast(err.message, 'error'); }
  }

  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="card stack">
        <h2>Sign-in protection</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Covers Workspace sign-in and mail apps (IMAP and SMTP). An address that fails {limits.maxFailures} sign-ins with different
          accounts or passwords within {limits.windowMin} minutes is blocked for {limits.banMin} minutes, and for 24 hours if it happens again.
          Retrying the same wrong password, for example a phone with an old password, counts once. An account attacked from many addresses
          is slowed down, never locked, so attackers can't lock your users out.
        </p>
        <p style={{ margin: 0 }}>
          <strong>{data.failures24h}</strong> failed sign-in{data.failures24h === 1 ? '' : 's'} in the last 24 hours ·{' '}
          <strong>{data.bans.length}</strong> address{data.bans.length === 1 ? '' : 'es'} blocked now
        </p>
        {data.natWarning && (
          <div className="banner warn" style={{ margin: 0 }}>
            Every recent failed sign-in comes from a private address. The real internet addresses are probably being hidden by your network setup,
            so blocking can't work. Make sure the router forwards ports straight to the NAS and the mail container's ports are published normally.
          </div>
        )}
      </div>

      <div className="card stack">
        <h2>Blocked addresses</h2>
        {data.bans.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing is blocked right now.</p> : (
          <table className="files">
            <thead><tr><th>Address</th><th className="hide-sm">Reason</th><th>Blocked until</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {data.bans.map((b) => (
                <tr key={b.ip}>
                  <td className="name"><span>{b.ip}</span>{b.strikes > 1 && <span className="pill ext">repeat</span>}</td>
                  <td className="hide-sm muted">{b.reason}</td>
                  <td className="muted">{when(b.until)}</td>
                  <td className="actions"><button className="btn small" onClick={() => unblock(b.ip)}>Unblock</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form className="card stack" onSubmit={saveAllow}>
        <h2>Never block</h2>
        <p className="muted small" style={{ margin: 0 }}>Your office's fixed IP, for example. One address or range per line, such as <code>203.0.113.10</code> or <code>203.0.113.0/24</code>. This server's own addresses are always exempt.</p>
        <textarea rows={4} aria-label="Allowlisted addresses" value={allow} onChange={(e) => setAllow(e.target.value)} spellCheck={false} />
        <div className="row end"><button className="btn primary">Save</button></div>
      </form>

      <div className="card stack">
        <h2>Recent failed sign-ins</h2>
        {data.recent.length === 0 ? <Empty title="No failed sign-ins" /> : (
          <table className="files">
            <thead><tr><th>Time</th><th>Address</th><th className="hide-sm">Account</th><th className="hide-sm">Where</th></tr></thead>
            <tbody>
              {data.recent.map((f, i) => (
                <tr key={i}>
                  <td className="muted">{when(f.at)}</td>
                  <td>{f.ip}</td>
                  <td className="hide-sm muted">{f.login || '—'}</td>
                  <td className="hide-sm muted">{SERVICE[f.service] || f.service}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
