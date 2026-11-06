// The page people open from a booking link (/b/<token>): pick a day, then a free time (shown in
// their own time zone), leave a name and email, and the time is booked.
import { useEffect, useState } from 'react';

async function call(method, url, body) {
  const res = await fetch(`/api/public/book${url}`, {
    method, headers: { 'x-requested-with': 'nas-workspace', ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
const dayName = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const longDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const localDay = (ms) => new Date(ms).toDateString();

export default function BookingPage({ token }) {
  const [page, setPage] = useState(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState(null);
  const [slot, setSlot] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const load = () => call('GET', `/${encodeURIComponent(token)}`).then((p) => { setPage(p); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (page?.title) document.title = `Book: ${page.title}`; }, [page?.title]);

  // Group the free times by the visitor's own day (their time zone may differ from the page's).
  const byDay = new Map();
  for (const t of (page?.days || []).flatMap((d) => d.slots)) {
    const k = localDay(t);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(t);
  }
  const days = [...byDay.entries()];
  const chosen = day && byDay.has(day) ? day : days[0]?.[0];

  async function book(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try { setDone(await call('POST', `/${encodeURIComponent(token)}`, { start: slot, ...form })); }
    catch (err) { setError(err.message); if (err.status === 409) { setSlot(null); load(); } }
    setBusy(false);
  }

  let body;
  if (error && !page) body = <div className="link-msg" role="alert"><h1>Booking not available</h1><p className="muted">{error}</p></div>;
  else if (!page) body = <p className="muted">Loading…</p>;
  else if (done) {
    body = (
      <section className="invite-card stack" aria-live="polite">
        <h1>You’re booked</h1>
        <p><strong>{done.title}</strong> with {done.owner.name}</p>
        <p>{longDay(done.start)}, {time(done.start)} – {time(done.end)}{zone && <span className="muted small"> · your time ({zone})</span>}</p>
        <p className="muted small">An invitation is on its way to {form.email}; add it to your calendar from there.</p>
      </section>
    );
  } else {
    body = (
      <section className="invite-card stack booking">
        <p className="muted small">Book time with {page.owner.name}</p>
        <h1>{page.title}</h1>
        <p className="muted" style={{ margin: 0 }}>{page.duration} minutes{page.description ? ` · ${page.description}` : ''}</p>
        {!days.length ? <p>There are no free times in the next few weeks. Please get in touch with {page.owner.name} another way.</p> : !slot ? <>
          <div className="booking-days" role="tablist" aria-label="Days">
            {days.map(([k, list]) => (
              <button key={k} type="button" role="tab" aria-selected={k === chosen} className={k === chosen ? 'on' : ''} onClick={() => setDay(k)}>
                {dayName(list[0])}<span className="muted small">{list.length} free</span>
              </button>
            ))}
          </div>
          <div className="booking-slots" role="group" aria-label={`Times on ${chosen ? longDay(byDay.get(chosen)[0]) : ''}`}>
            {(byDay.get(chosen) || []).map((t) => <button key={t} type="button" className="btn" onClick={() => setSlot(t)}>{time(t)}</button>)}
          </div>
          <p className="muted small" style={{ margin: 0 }}>Times are in your time zone{zone ? ` (${zone})` : ''}.</p>
        </> : (
          <form className="stack" onSubmit={book}>
            <p style={{ margin: 0 }}><strong>{longDay(slot)}, {time(slot)} – {time(slot + page.duration * 6e4)}</strong> · <button type="button" className="link-btn" onClick={() => setSlot(null)}>change</button></p>
            <label className="field"><span>Your name</span><input required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Your email</span><input required type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="field"><span>Anything to add (optional)</span><textarea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Booking…' : 'Book'}</button></div>
          </form>
        )}
        {error && <p className="error small" role="alert">{error}</p>}
      </section>
    );
  }
  return (
    <div className="link-page">
      <header className="link-head"><div className="brand"><span className="brand-mark">W</span><span className="brand-text">Workspace</span></div></header>
      <main className="link-main">{body}</main>
    </div>
  );
}
