// Admin → Phishing: emails people in the company reported as phishing (Mail → Report phishing), by
// sender: how many reports, who, the subjects. Dealt with one? Mark it handled (a new report brings it back).
import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { Empty, useToast } from '../../components/ui.jsx';

export default function PhishingAdmin() {
  const toast = useToast();
  const [list, setList] = useState(null);
  useEffect(() => { get('/orgs/current/phishing').then(setList).catch((e) => toast(e.message, 'error')); }, [toast]);
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
                  <td className="actions">{g.handled_at
                    ? <button type="button" className="btn small" aria-label={`Not handled: ${g.sender}`} onClick={() => mark(g, false)}>Not handled</button>
                    : <button type="button" className="btn small" aria-label={`Mark handled: ${g.sender}`} onClick={() => mark(g, true)}>Mark handled</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
    </section>
  );
}
