// Admin: post a company announcement (for everyone or one group, now or from a set time), see who has
// dismissed each, take one down.
import { useEffect, useState } from 'react';
import { get, post, del, onLive } from '../../api.js';
import { useToast } from '../../components/ui.jsx';

const ENDS = [['', 'When I take it down'], ['1', 'After 1 day'], ['7', 'After 1 week'], ['30', 'After 30 days']];

export default function AnnouncementsAdmin({ mail = false }) {
  const toast = useToast();
  const [list, setList] = useState(null);
  const blank = { text: '', link: '', tone: 'info', ends: '', start: '', group: '', email: false };
  const [f, setF] = useState(blank);
  const [groups, setGroups] = useState([]);
  const load = () => get('/announcements/all').then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); get('/groups').then(setGroups).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A scheduled one starting moves it to Showing now.
  useEffect(() => onLive((m) => { if (m.type === 'announcements-changed') load(); }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (e) => {
    e.preventDefault();
    try {
      const startsAt = f.start ? new Date(f.start).getTime() : null;
      const group = groups.find((g) => g.id === f.group);
      await post('/announcements', { text: f.text, link: f.link || null, tone: f.tone, starts_at: startsAt, group_id: f.group || null, email: f.email,
        until: f.ends ? (startsAt || Date.now()) + Number(f.ends) * 864e5 : null });
      setF(blank);
      const who = group ? `everyone in ${group.name}` : 'everyone in the company';
      const mailed = f.email ? (startsAt && startsAt > Date.now() ? ', and gets it by email then' : ', and by email') : '';
      toast(startsAt && startsAt > Date.now() ? `Announcement scheduled: ${who} sees it from ${when(startsAt)}${mailed}` : `Announcement posted: ${who} sees it now${mailed}`);
      load();
    } catch (err) { toast(err.message, 'error'); }
  };
  const remove = async (a) => { await del(`/announcements/${a.id}`).catch((e) => toast(e.message, 'error')); load(); };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <form className="card stack" onSubmit={submit}>
        <h2 style={{ margin: 0 }}>New announcement</h2>
        <p className="muted small" style={{ margin: 0 }}>Shown at the top of Workspace to everyone in the company (or in one group) until they dismiss it or it ends.</p>
        <label className="field"><span>Announcement</span><input required maxLength={300} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="Office closed on Friday for the holiday" /></label>
        <div className="row wrap">
          <label className="field grow"><span>Link (optional)</span><input value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} placeholder="https://… or /docs/…" /></label>
          <label className="field"><span>Style</span><select value={f.tone} onChange={(e) => setF({ ...f, tone: e.target.value })}><option value="info">📣 Notice</option><option value="warn">⚠️ Important</option></select></label>
          <label className="field"><span>Ends</span><select value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })}>{ENDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </div>
        <div className="row wrap">
          <label className="field"><span>Who sees it</span><select value={f.group} onChange={(e) => setF({ ...f, group: e.target.value })}>
            <option value="">Everyone in the company</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.members.length})</option>)}
          </select></label>
          <label className="field"><span>Starts</span><input type="datetime-local" value={f.start} min={localInput(Date.now())} onChange={(e) => setF({ ...f, start: e.target.value })} /></label>
          {f.start && <button type="button" className="link-btn small" style={{ alignSelf: 'flex-end', marginBottom: 10 }} onClick={() => setF({ ...f, start: '' })}>Start now instead</button>}
        </div>
        {!f.start && <p className="muted small" style={{ margin: 0 }}>Leave <em>Starts</em> empty to show it straight away.</p>}
        {mail && <label className="check"><input type="checkbox" checked={f.email} onChange={(e) => setF({ ...f, email: e.target.checked })} /> Also email it to them (from you{f.start ? ', when it starts' : ''})</label>}
        <div className="row end"><button className="btn primary">{f.start ? 'Schedule' : 'Post'}</button></div>
      </form>
      <h2 style={{ margin: 0 }}>Showing now</h2>
      <AnnouncementList list={list?.filter((a) => !a.starts_at || a.starts_at <= Date.now())} label="Current announcements" empty="No announcements." onRemove={remove} />
      {list?.some((a) => a.starts_at > Date.now()) && <>
        <h2 style={{ margin: 0 }}>Scheduled</h2>
        <AnnouncementList list={list.filter((a) => a.starts_at > Date.now())} label="Scheduled announcements" onRemove={remove} />
      </>}
    </div>
  );
}

const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
/** A time as a datetime-local input's value (local time, to the minute). */
const localInput = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function AnnouncementList({ list, label, empty, onRemove }) {
  if (list?.length === 0) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <ul className="announcement-admin-list" aria-label={label}>
      {list?.map((a) => (
        <li key={a.id} className="row">
          <span className="grow">{a.tone === 'warn' ? '⚠️ ' : '📣 '}{a.text} <span className="muted small">
            · {a.author_name || 'someone'} · {a.group_name ? `for ${a.group_name} (${a.group_size})` : 'for everyone'}
            {a.starts_at > Date.now() ? ` · from ${when(a.starts_at)}` : ''} · {a.until ? `until ${new Date(a.until).toLocaleDateString()}` : 'until taken down'}
            {!(a.starts_at > Date.now()) && ` · dismissed by ${a.dismissed}`}
            {a.email ? (a.emailed_at ? ` · ✉ emailed to ${a.emailed_to ?? 0}` : ' · ✉ will be emailed') : ''}</span></span>
          <button type="button" className="btn small" onClick={() => onRemove(a)}>{a.starts_at > Date.now() ? 'Cancel' : 'Take down'}</button>
        </li>
      ))}
    </ul>
  );
}
