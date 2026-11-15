// Admin → Phishing → Practice emails: send chosen colleagues a practice phishing email, and see who
// clicked its link and who reported it (Mail → Report phishing). See server/src/phishpractice.js.
import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { useToast } from '../../components/ui.jsx';

export default function PhishPractice() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [template, setTemplate] = useState('password');
  const [chosen, setChosen] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // the round whose people are shown
  const [custom, setCustom] = useState({ from: '', subject: '', text: 'Hello,\n\n…\n\n{link}' });
  const load = () => get('/orgs/current/phish-practice').then(setData).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); get('/users/directory').then((d) => setPeople(d.filter((p) => !p.external))).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const t = data.templates.find((x) => x.id === template);
  const toggle = (id) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const send = async () => {
    setBusy(true);
    try {
      const r = await post('/orgs/current/phish-practice', { template, user_ids: [...chosen], ...(template === 'custom' && { custom }) });
      toast(`Practice email sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}${r.failed ? ` (${r.failed} couldn’t be sent)` : ''}`);
      setChosen(new Set()); load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const when = (x) => new Date(x).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const pct = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '—');
  return (
    <section className="card stack" aria-labelledby="practice-h">
      <h2 id="practice-h">Practice emails</h2>
      <p className="muted small" style={{ margin: 0 }}>Send colleagues a realistic practice phishing email. Clicking its link opens a page saying it was practice and what gave it away; using <strong>Report phishing</strong> is the right answer and counts as spotting it. It comes from your address under a made-up name, and nothing is collected.</p>
      <label className="field" style={{ maxWidth: 360 }}><span>Practice email</span>
        <select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Practice email">
          {data.templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          <option value="custom">Write your own…</option>
        </select></label>
      {t && <p className="small" style={{ margin: 0 }}>From <strong>{t.from}</strong>: “{t.subject}”</p>}
      {template === 'custom' && (
        <div className="stack-tight">
          <label className="field" style={{ maxWidth: 360 }}><span>Pretends to be from</span><input value={custom.from} maxLength={60} placeholder="e.g. DHL Express" onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
          <label className="field"><span>Subject</span><input value={custom.subject} maxLength={200} placeholder="e.g. Your parcel is held at customs" onChange={(e) => setCustom({ ...custom, subject: e.target.value })} /></label>
          <label className="field"><span>Text</span><textarea rows={6} value={custom.text} maxLength={5000} onChange={(e) => setCustom({ ...custom, text: e.target.value })} /></label>
          <p className="muted small" style={{ margin: 0 }}><code>{'{link}'}</code> is where the practice link goes (at the end if it’s left out). Imitate what your company really gets: a supplier, a courier, the payroll system.</p>
        </div>
      )}
      <fieldset className="practice-people">
        <legend>Who gets it</legend>
        <label className="check"><input type="checkbox" checked={people.length > 0 && chosen.size === people.length} onChange={(e) => setChosen(e.target.checked ? new Set(people.map((p) => p.id)) : new Set())} /> Everyone ({people.length})</label>
        <div className="practice-list">{people.map((p) => <label key={p.id} className="check"><input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} /> {p.name} <span className="muted small">{p.username}</span></label>)}</div>
      </fieldset>
      <div className="row"><button type="button" className="btn primary" disabled={busy || !chosen.size || (template === 'custom' && !(custom.from.trim() && custom.subject.trim() && custom.text.trim()))} onClick={send}>{busy ? 'Sending…' : `Send to ${chosen.size || 'no'} ${chosen.size === 1 ? 'person' : 'people'}`}</button></div>
      {data.rounds.length > 0 && (
        <table className="files" aria-label="Practice rounds">
          <thead><tr><th scope="col">Sent</th><th scope="col">Email</th><th scope="col">To</th><th scope="col">Clicked</th><th scope="col">Reported</th><th /></tr></thead>
          <tbody>{data.rounds.map((r) => (
            <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.name}</td><td>{r.sent}</td><td>{r.clicked} ({pct(r.clicked, r.sent)})</td><td>{r.reported} ({pct(r.reported, r.sent)})</td>
              <td><button type="button" className="btn small" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide people' : 'People'}</button></td></tr>
          ))}</tbody>
        </table>
      )}
      {open && (() => {
        const r = data.rounds.find((x) => x.id === open);
        return (
          <ul className="practice-results" aria-label={`People sent “${r.name}”`}>
            {r.people.map((p) => <li key={p.id}><strong>{p.name}</strong> <span className="muted small">{p.email}</span> · {p.error ? `not sent (${p.error})` : p.reported_at ? `✓ reported it ${when(p.reported_at)}` : p.clicked_at ? `clicked the link ${when(p.clicked_at)}` : 'no action yet'}{p.clicked_at && p.reported_at ? ' (after clicking)' : ''}</li>)}
          </ul>
        );
      })()}
    </section>
  );
}
