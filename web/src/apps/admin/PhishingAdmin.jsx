// Admin → Phishing: emails people in the company reported as phishing (Mail → Report phishing), by
// sender: how many reports, who, the subjects. Dealt with one? Mark it handled (a new report brings it back).
import { useEffect, useState } from 'react';
import { get, post, del } from '../../api.js';
import { ConfirmModal, Empty, PromptModal, useToast } from '../../components/ui.jsx';
import { warningText } from './phishingtext.js';

export default function PhishingAdmin() {
  const toast = useToast();
  const [list, setList] = useState(null);
  useEffect(() => { get('/orgs/current/phishing').then(setList).catch((e) => toast(e.message, 'error')); }, [toast]);
  const [blocked, setBlocked] = useState([]);
  const [asking, setAsking] = useState(null); // the address or domain to block, while confirming
  const [typed, setTyped] = useState('');
  const [warning, setWarning] = useState(null); // the report being announced to everyone
  const [sweeping, setSweeping] = useState(null); // { value } while confirming, { value, busy } while it runs
  useEffect(() => { get('/orgs/current/blocked').then(setBlocked).catch(() => {}); }, []);
  const block = async (value) => {
    try { const r = await post('/orgs/current/blocked', { value }); setBlocked(r.blocked); setList(r.reports); setTyped(''); toast(`${value} is blocked for everyone: their mail goes to Junk`); } catch (e) { toast(e.message, 'error'); }
  };
  const unblock = async (value) => {
    try { setBlocked((await del(`/orgs/current/blocked/${encodeURIComponent(value)}`)).blocked); toast(`${value} is no longer blocked`); } catch (e) { toast(e.message, 'error'); }
  };
  const isBlocked = (g) => blocked.some((b) => b.value === g.sender || g.domain === b.value || g.domain.endsWith(`.${b.value}`));
  const mark = async (g, handled) => {
    try { setList(await post('/orgs/current/phishing/handled', { sender: g.sender, handled })); toast(handled ? `${g.sender}: marked handled` : `${g.sender}: back on the list`); } catch (e) { toast(e.message, 'error'); }
  };
  const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  if (!list) return null;
  const open = list.filter((g) => !g.handled_at).length;
  return (
    <section className="card stack" aria-labelledby="phish-h">
      <h2 id="phish-h">Phishing reports</h2>
      <p className="muted small" style={{ margin: 0 }}>Emails people here reported with <strong>Report phishing</strong> in Mail, by sender. You're told of each in the bell. Warn everyone (an announcement, say) and ask the sender's company or your provider to act on it; then mark it handled. A new report of the same sender brings it back.</p>
      {!list.length ? <Empty icon="shield" title="No reports">Nobody has reported a phishing email.</Empty>
        : <>
          <p className="small" role="status">{open ? `${open} sender${open === 1 ? '' : 's'} to look at` : 'All handled'}</p>
          <table className="files">
            <thead><tr><th>Sender</th><th>Reports</th><th className="hide-sm">Subjects</th><th className="hide-sm">Latest</th><th /></tr></thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.sender} className={g.handled_at ? 'muted' : ''}>
                  <td><strong>{g.sender}</strong><div className="small muted">{g.domain}</div></td>
                  <td title={g.people.join(', ')}>{g.reports}<div className="small muted">{g.people.slice(0, 3).join(', ')}{g.people.length > 3 ? ` and ${g.people.length - 3} more` : ''}</div></td>
                  <td className="hide-sm small">{g.subjects.map((x) => <div key={x}>“{x}”</div>)}</td>
                  <td className="hide-sm small">{when(g.last_at)}{g.handled_at && <div className="muted">Handled by {g.handled_by || 'an admin'}</div>}</td>
                  <td className="actions">{isBlocked(g) ? <span className="pill">Blocked</span> : <>
                    <button type="button" className="btn small" aria-label={`Block sender ${g.sender}`} onClick={() => setAsking(g.sender)}>Block sender</button>
                    <button type="button" className="btn small" aria-label={`Block domain ${g.domain}`} onClick={() => setAsking(g.domain)}>Block domain</button></>}
                    <button type="button" className="btn small" aria-label={`Warn everyone about ${g.sender}`} onClick={() => setWarning(g)}>Warn everyone</button>
                    <button type="button" className="btn small" aria-label={`Remove from inboxes: ${g.sender}`} onClick={() => setSweeping({ value: g.sender })}>Remove from inboxes</button>
                    {g.handled_at
                    ? <button type="button" className="btn small" aria-label={`Not handled: ${g.sender}`} onClick={() => mark(g, false)}>Not handled</button>
                    : <button type="button" className="btn small" aria-label={`Mark handled: ${g.sender}`} onClick={() => mark(g, true)}>Mark handled</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
      <h3 id="blocked-h">Blocked for everyone</h3>
      <p className="muted small" style={{ margin: 0 }}>Mail from these goes straight to Junk, marked read, for everyone in the company (on phones too): no filters, forwarding or vacation replies run for it. A domain covers its subdomains.</p>
      {blocked.length > 0 && (
        <ul className="plain-list" aria-labelledby="blocked-h">
          {blocked.map((b) => (
            <li key={b.value} className="row"><span className="grow"><strong>{b.value}</strong> <span className="muted small">· by {b.added_by || 'an admin'}, {when(b.added_at)}</span></span>
              <button type="button" className="btn small" aria-label={`Unblock ${b.value}`} onClick={() => unblock(b.value)}>Unblock</button></li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setAsking(typed.trim()); }}>
        <input className="grow" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="name@example.com or example.com" aria-label="Address or domain to block" maxLength={200} />
        <button className="btn" disabled={!typed.trim()}>Block</button>
      </form>
      {warning && <PromptModal title="Warn everyone" label="Announcement (at the top of Workspace for everyone, for a week)" confirm="Announce"
        initial={warningText(warning)} onClose={() => setWarning(null)}
        onSubmit={async (text) => { await post('/announcements', { text, tone: 'warn', until: Date.now() + 7 * 864e5 }); toast('Everyone sees the warning now (Admin → Announcements to change or end it)'); }} />}
      {sweeping && <ConfirmModal title={`Remove mail from ${sweeping.value} from everyone's Inbox?`} confirm={sweeping.busy ? 'Removing…' : 'Remove from inboxes'}
        message={`Everyone's Inbox in the company is searched for mail from ${sweeping.value}, and what's found is moved to Junk, marked read (on phones too), even if they haven't seen it yet. Nothing is deleted.`}
        onClose={() => setSweeping(null)} onConfirm={async () => {
          setSweeping({ ...sweeping, busy: true });
          try {
            const r = await post('/orgs/current/phishing/sweep', { value: sweeping.value });
            toast(r.messages ? `Moved ${r.messages} email${r.messages === 1 ? '' : 's'} to Junk, from ${r.people} ${r.people === 1 ? 'person' : 'people'}'s Inbox${r.failed.length ? ` (${r.failed.length} mailbox${r.failed.length === 1 ? '' : 'es'} couldn't be reached)` : ''}` : `Nothing from ${sweeping.value} left in anyone's Inbox`);
          } catch (e) { toast(e.message, 'error'); }
          setSweeping(null);
        }} />}
      {asking && <ConfirmModal title={`Block ${asking} for everyone?`} confirm="Block for everyone"
        message={`All mail from ${asking.includes('@') ? asking : `${asking} (and its subdomains)`} will go to Junk, marked read, for everyone in the company, from now on. Mail already delivered stays where it is.`}
        onClose={() => setAsking(null)} onConfirm={async () => { await block(asking); setAsking(null); }} />}
    </section>
  );
}
