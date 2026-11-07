// Admin: post a company announcement, see who has dismissed each, take one down.
import { useEffect, useState } from 'react';
import { get, post, del } from '../../api.js';
import { useToast } from '../../components/ui.jsx';

const ENDS = [['', 'When I take it down'], ['1', 'After 1 day'], ['7', 'After 1 week'], ['30', 'After 30 days']];

export default function AnnouncementsAdmin() {
  const toast = useToast();
  const [list, setList] = useState(null);
  const [f, setF] = useState({ text: '', link: '', tone: 'info', ends: '' });
  const load = () => get('/announcements/all').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (e) => {
    e.preventDefault();
    try {
      await post('/announcements', { text: f.text, link: f.link || null, tone: f.tone, until: f.ends ? Date.now() + Number(f.ends) * 864e5 : null });
      setF({ text: '', link: '', tone: 'info', ends: '' });
      toast('Announcement posted: everyone in the company sees it now');
      load();
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <form className="card stack" onSubmit={submit}>
        <h2 style={{ margin: 0 }}>New announcement</h2>
        <p className="muted small" style={{ margin: 0 }}>Shown at the top of Workspace to everyone in the company until they dismiss it or it ends.</p>
        <label className="field"><span>Announcement</span><input required maxLength={300} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="Office closed on Friday for the holiday" /></label>
        <div className="row wrap">
          <label className="field grow"><span>Link (optional)</span><input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://… or /docs/…" /></label>
          <label className="field"><span>Style</span><select value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}><option value="info">📣 Notice</option><option value="warn">⚠️ Important</option></select></label>
          <label className="field"><span>Ends</span><select value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })}>{ENDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </div>
        <div className="row end"><button className="btn primary">Post</button></div>
      </form>
      <h2 style={{ margin: 0 }}>Showing now</h2>
      {list?.length === 0 && <p className="muted">No announcements.</p>}
      <ul className="announcement-admin-list" aria-label="Current announcements">
        {list?.map((a) => (
          <li key={a.id} className="row">
            <span className="grow">{a.tone === 'warn' ? '⚠️ ' : '📣 '}{a.text} <span className="muted small">· {a.author_name || 'someone'} · {a.until ? `until ${new Date(a.until).toLocaleDateString()}` : 'until taken down'} · dismissed by {a.dismissed}</span></span>
            <button type="button" className="btn small" onClick={async () => { await del(`/announcements/${a.id}`).catch((e) => toast(e.message, 'error')); load(); }}>Take down</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
