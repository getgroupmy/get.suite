// The page someone outside the server opens from an invitation email: /i/<token>.
import { useEffect, useState } from 'react';
import { describeRule } from './calmath.js';

const LABELS = { yes: 'Yes', maybe: 'Maybe', no: 'No' };
const DONE = { yes: 'You’re going.', maybe: 'You might go.', no: 'You’re not going.' };

async function call(method, url, body) {
  const res = await fetch(`/api/public/invites${url}`, {
    method, headers: { 'x-requested-with': 'nas-workspace', ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/** When, in the viewer's own time zone (the email shows the organizer's). */
function localWhen(ev) {
  const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ev.all_day) {
    const last = new Date(ev.end);
    return new Date(ev.start).toDateString() === last.toDateString() ? `${day(ev.start)}, all day` : `${day(ev.start)} – ${day(ev.end)}`;
  }
  const sameDay = new Date(ev.start).toDateString() === new Date(ev.end).toDateString();
  return sameDay ? `${day(ev.start)}, ${time(ev.start)} – ${time(ev.end)}` : `${day(ev.start)} ${time(ev.start)} – ${day(ev.end)} ${time(ev.end)}`;
}

export default function InviteAnswer({ token }) {
  const [ev, setEv] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('GET', `/${encodeURIComponent(token)}`).then(setEv).catch((e) => setError(e.message)); }, [token]);
  useEffect(() => { if (ev?.title) document.title = ev.title; }, [ev?.title]);

  async function answer(status) {
    setBusy(true);
    try { setEv(await call('POST', `/${encodeURIComponent(token)}/answer`, { status })); } catch (e) { setError(e.message); }
    setBusy(false);
  }

  let body;
  if (error && !ev) body = <div className="link-msg" role="alert"><h1>Invitation not available</h1><p className="muted">{error}</p></div>;
  else if (!ev) body = <p className="muted">Loading…</p>;
  else {
    const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
    body = (
      <section className="invite-card stack">
        <p className="muted small">{ev.organizer.name} ({ev.organizer.email}) invited you</p>
        <h1>{ev.title}</h1>
        <dl className="invite-facts">
          <dt>When</dt><dd>{localWhen(ev)}{zone && <span className="muted small"> · your time ({zone})</span>}</dd>
          {ev.rrule && <><dt>Repeats</dt><dd>{describeRule(ev.rrule, ev.start)}</dd></>}
          {ev.location && <><dt>Where</dt><dd>{ev.location}</dd></>}
          {ev.description && <><dt>Details</dt><dd className="pre">{ev.description}</dd></>}
        </dl>
        <div className="stack" style={{ gap: 8 }}>
          <strong>Going?</strong>
          <div className="row" role="group" aria-label="Your answer">
            {['yes', 'maybe', 'no'].map((s) => (
              <button key={s} type="button" className={`btn ${ev.status === s ? 'primary' : ''}`} aria-pressed={ev.status === s} disabled={busy} onClick={() => answer(s)}>{LABELS[s]}</button>
            ))}
          </div>
          <p className="muted small" aria-live="polite">{DONE[ev.status] ? `${DONE[ev.status]} ${ev.organizer.name} can see your answer, and you can change it here any time.` : `Answering as ${ev.email}.`}</p>
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
        <a className="link-btn" href={`/api/public/invites/${encodeURIComponent(token)}/ics`}>Add to my calendar (.ics file)</a>
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
