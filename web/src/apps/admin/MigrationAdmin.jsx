// Admin → Moving here: who has brought their mail and files over from the old service, who is part-way,
// and whose import stopped (server: migrationstatus.js).
import { useEffect, useState } from 'react';
import { get, post } from '../../api.js';
import { Empty, Modal, useToast } from '../../components/ui.jsx';

const when = (t) => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const SHOW = [['all', 'Everyone'], ['nothing', 'Not started'], ['failed', 'Import stopped'], ['running', 'Importing now'], ['done', 'Mail imported']];

export default function MigrationAdmin() {
  const [data, setData] = useState(null);
  const [show, setShow] = useState('all');
  const [reminding, setReminding] = useState(null); // the note being written, or null
  const toast = useToast();
  useEffect(() => {
    let live = true;
    const load = () => get('/orgs/current/migration').then((d) => live && setData(d)).catch(() => live && setData({ people: [], counts: {} }));
    load();
    const t = setInterval(load, 15000); // imports carry on in the background
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!data) return <p className="muted">Loading…</p>;
  const c = data.counts;
  const list = data.people.filter((p) => show === 'all' || (show === 'nothing' ? !p.mail && !p.data : p.mail?.status === show));
  return (
    <div className="stack">
      <section className="card stack" aria-labelledby="moving-h">
        <h2 id="moving-h">Moving here</h2>
        <p className="muted small" style={{ margin: 0 }}>How far each person has got bringing their mail and files over. People find the steps for Google, Microsoft 365 and Zoho in <strong>Settings → Move here from another service</strong>, and their mail in <strong>Mail → Import mail</strong>; you can bring an export in for someone with <strong>Users → ⋮ → Bring in their data…</strong>.</p>
        <div className="row wrap migration-counts" role="list" aria-label="So far">
          <span role="listitem"><strong>{c.mail_done}</strong> of {c.people} mail imported</span>
          <span role="listitem"><strong>{c.mail_running}</strong> importing now</span>
          <span role="listitem" className={c.mail_failed ? 'bad' : ''}><strong>{c.mail_failed}</strong> stopped</span>
          <span role="listitem"><strong>{c.data}</strong> brought in an export</span>
          <span role="listitem"><strong>{c.nothing}</strong> not started</span>
        </div>
        {c.nothing > 0 && <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setReminding('')}>Remind those who haven’t started ({c.nothing})</button>}
        <label className="field" style={{ maxWidth: 260 }}><span>Show</span>
          <select value={show} onChange={(e) => setShow(e.target.value)}>{SHOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </section>
      {!list.length ? <Empty icon="people" title="Nobody here" /> : (
        <div className="table-scroll">
          <table className="data-table migration-table" aria-label="People">
            <thead><tr><th scope="col">Person</th><th scope="col">Mail</th><th scope="col">Export brought in</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.name}</strong><br /><span className="muted small">{p.email}</span></td>
                  <td>{!p.mail ? <span className="muted">Not started</span>
                    : p.mail.status === 'running' ? <>Importing from {p.mail.from}: {p.mail.copied + p.mail.skipped} of {p.mail.total || '…'}<progress max={p.mail.total || 1} value={p.mail.copied + p.mail.skipped} aria-label={`${p.name}: import progress`} /></>
                    : p.mail.status === 'done' ? <>✓ {p.mail.copied} from {p.mail.from}<br /><span className="muted small">{when(p.mail.finished_at)}</span></>
                    : <span className="error">Stopped ({p.mail.from}, {p.mail.copied} copied): {p.mail.error}</span>}</td>
                  <td>{p.data ? <>{p.data.from ? `From ${p.data.from}: ` : ''}{p.data.summary}<br /><span className="muted small">{when(p.data.at)}{p.data.by_admin ? ' · by an admin' : ''}</span></> : <span className="muted">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reminding !== null && (
        <Modal title="Remind those who haven’t started" onClose={() => setReminding(null)} footer={<>
          <button type="button" className="btn" onClick={() => setReminding(null)}>Cancel</button>
          <button type="button" className="btn primary" onClick={async () => {
            try { const r = await post('/orgs/current/migration/remind', { message: reminding }); toast(`Reminded ${r.reminded} ${r.reminded === 1 ? 'person' : 'people'}`); setReminding(null); } catch (e) { toast(e.message, 'error'); }
          }}>Send reminder</button>
        </>}>
          <p className="small" style={{ marginTop: 0 }}>The {c.nothing} {c.nothing === 1 ? 'person' : 'people'} who haven’t imported mail or brought in an export get a notification (on their phones too, if they’ve turned that on) linking to the steps in Settings.</p>
          <label className="field"><span>A note from you (optional)</span><textarea rows={3} maxLength={300} value={reminding} onChange={(e) => setReminding(e.target.value)} placeholder="e.g. Please bring your mail over by Friday: the old accounts close next week." /></label>
        </Modal>
      )}
    </div>
  );
}
