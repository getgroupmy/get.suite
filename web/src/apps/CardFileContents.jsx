// A calendar file (.ics) or contact cards (.vcf), shown as what's in them: its events (title, when, where) or its
// people (name, address, phone, company), with Add to Calendar or Add to Contacts. `fileId` for one kept in Drive;
// `source` ({ url, name }) for one that isn't (an email's attachment, a file sent in Chat): its text is read from url.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { get, post, postText } from '../api.js';
import { useToast } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const when = (e) => {
  if (e.all_day) return new Date(e.start).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const s = new Date(e.start), t = new Date(e.end);
  const day = s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const hm = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${hm(s)}–${hm(t)}`;
};
const n = (k, one, many = `${one}s`) => `${k.toLocaleString()} ${k === 1 ? one : many}`;

export default function CardFileContents({ fileId = null, source = null, canAdd = true }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(null); // the file's text, when it isn't in Drive
  const toast = useToast();
  const navigate = useNavigate();
  useEffect(() => {
    let live = true;
    setD(null); setError('');
    const read = fileId ? get(`/files/${fileId}/cards?tz=${encodeURIComponent(TZ)}`)
      : fetch(source.url, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error('The file couldn’t be read'); return r.text(); })
        .then((text) => { if (live) setText(text); return postText(`/files/read-cards?name=${encodeURIComponent(source.name)}&tz=${encodeURIComponent(TZ)}`, text); });
    read.then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [fileId, source?.url, source?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!d) return <p className="muted">Reading the file…</p>;
  const cal = d.kind === 'calendar';
  const add = async () => {
    setBusy(true);
    try {
      const r = fileId ? (cal ? await post(`/files/${fileId}/add-events`, { tz: TZ }) : await post('/contacts/from-file', { file: fileId }))
        : cal ? await postText(`/events/import?tz=${encodeURIComponent(TZ)}`, text) : await postText('/contacts/import', text);
      const what = cal ? n(r.added, 'event') : n(r.added, 'contact');
      toast([`${what} added to ${cal ? 'Calendar' : 'Contacts'}`, r.skipped && `${r.skipped} already there`, r.failed && `${r.failed} couldn’t be read`].filter(Boolean).join(', '),
        'info', r.added ? { action: { label: 'Show', onClick: () => navigate(cal ? '/calendar' : '/contacts') } } : undefined);
    } catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  const shown = cal ? d.events.length : d.contacts.length;
  return (
    <section className="card-file stack-tight" aria-label={cal ? 'Events in this calendar file' : 'People in these contact cards'}>
      <div className="row wrap">
        <strong className="grow">{cal ? n(d.total, 'event') : n(d.total, 'person', 'people')}{d.total > shown ? ` (the first ${shown} shown)` : ''}</strong>
        {canAdd && d.total > 0 && <button type="button" className="btn primary" disabled={busy} onClick={add}>
          <Icon name={cal ? 'calendar' : 'person'} size={18} /> {busy ? 'Adding…' : cal ? 'Add to Calendar' : 'Add to Contacts'}</button>}
      </div>
      {cal ? (
        <ul className="card-file-list">
          {d.events.map((e, i) => <li key={i}><strong>{e.title || '(no title)'}</strong> <span className="muted small">{when(e)}{e.repeats ? ' · repeats' : ''}{e.location ? ` · ${e.location}` : ''}</span></li>)}
        </ul>
      ) : (
        <ul className="card-file-list">
          {d.contacts.map((c, i) => <li key={i}><strong>{c.name || c.email || '(no name)'}</strong> <span className="muted small">{[c.email, c.phone, c.company].filter(Boolean).join(' · ')}</span></li>)}
        </ul>
      )}
      {!canAdd && <p className="muted small">The owner has turned off downloading and copying, so these can’t be added from here.</p>}
      <p className="muted small">Anything already in your {cal ? 'calendar' : 'contacts'} isn’t added twice.</p>
    </section>
  );
}
