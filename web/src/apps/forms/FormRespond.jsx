// The page people fill a form in on (/f/<token>). Company forms need the visitor signed in to that
// company (they can sign in right here); "anyone with the link" forms need nothing.
import { requestSummary } from '../drive/requestkinds.js';
import { checkProblem } from './formcheck.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { sectionsOf, nextPage, prefillFrom, shuffled, draftFrom } from './formmath.js';
import { themeStyle } from './formtheme.js';
import { SignaturePad, textPicture, trimmed, SCRIPT_FONT } from '../../components/SignaturePad.jsx';

async function call(method, url, body) {
  const res = await fetch(`/api/public/forms${url}`, {
    method, headers: { 'x-requested-with': 'nas-workspace', ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const empty = (a) => a === undefined || a === '' || (Array.isArray(a) && !a.length);
/** A grid is answered when every row is. */
const unanswered = (q, a) => (q.type === 'grid' || q.type === 'checkgrid' ? (q.rows || []).some((row) => empty(a?.[row])) : empty(a));

export default function FormRespond({ token, onSignIn }) {
  const [form, setForm] = useState(null);
  // Drafts (signed in): what they've answered is kept on the server as they go, to finish later.
  const draft = useRef({ checked: false, timer: null });
  const touched = useRef(false); // changed something here (only then is anything saved)
  const [restored, setRestored] = useState(null); // when the draft that came back was saved
  const [saving, setSaving] = useState(null); // 'saving' | 'saved' | 'failed'
  const [cleared, setCleared] = useState(0); // Clear form starts each question afresh (a drawn signature too)
  const [error, setError] = useState(null); // { status, message }
  const [answers, setAnswers] = useState({});
  const [email, setEmail] = useState(''); // asked for when the form collects email addresses
  const [emailMissing, setEmailMissing] = useState(false);
  const [missing, setMissing] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [done, setDone] = useState(null);
  const [trail, setTrail] = useState([0]); // the pages they've been through; the last is the one shown
  // Changing a response sent earlier (?edit=<key>, the private link they got): its answers, and the files it sent.
  const [editing, setEditing] = useState(() => { const k = new URLSearchParams(window.location.search).get('edit'); return k ? { key: k, files: {}, loaded: false } : null; });
  useEffect(() => {
    if (!editing || editing.loaded || !form) return;
    call('GET', `/${encodeURIComponent(token)}/response/${encodeURIComponent(editing.key)}`)
      .then((r) => { setAnswers(r.answers || {}); setEditing({ ...editing, files: r.files || {}, loaded: true }); })
      .catch((e) => setError({ status: e.status, message: e.message }));
  }, [editing, form, token]);
  // A pre-filled link (?prefill=…): start with those answers (not when changing a response sent earlier).
  const load = () => call('GET', `/${encodeURIComponent(token)}`).then((f) => {
    setForm(f); setError(null);
    const pre = new URLSearchParams(window.location.search).get('prefill');
    if (pre && !editing) setAnswers((a) => ({ ...prefillFrom(f.questions, pre), ...a }));
    // Signed in: the answers they'd started here before come back (not over a pre-filled link's).
    if (f.can_save && f.accepting && !f.answered && !editing && !pre && !draft.current.checked) {
      draft.current.checked = true;
      call('GET', `/${encodeURIComponent(token)}/draft`).then(({ draft: d }) => {
        if (!d || touched.current) return;
        const back = draftFrom(f.questions, d.answers, d.trail, sectionsOf(f.questions).length);
        if (!Object.keys(back.answers).length) return;
        setAnswers(back.answers); setTrail(back.trail); setRestored(d.updated_at); setCleared((n) => n + 1);
      }).catch(() => {});
    }
  }).catch((e) => setError({ status: e.status, message: e.message }));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // A form that opens later: the page opens it by itself when the time comes (if it's left open).
  useEffect(() => {
    const wait = form?.opens_at ? form.opens_at - Date.now() + 500 : null;
    if (wait === null || wait > 864e5) return undefined;
    const t = setTimeout(load, Math.max(0, wait));
    return () => clearTimeout(t);
  }, [form?.opens_at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = form?.title || 'Form'; }, [form?.title]);

  const set = (id, v) => { touched.current = true; setAnswers((a) => ({ ...a, [id]: v })); setMissing((m) => m.filter((x) => x !== id)); };
  const pages = form ? sectionsOf(form.questions) : [];
  const page = trail[trail.length - 1];
  const after = form ? nextPage(pages, Math.min(page, pages.length - 1), answers) : 0;
  // Saved a second after the last change (an empty form deletes the draft); not once it's sent.
  const drafting = !!form?.can_save && form.accepting && !form.answered && !editing && !done;
  useEffect(() => {
    if (!drafting || !touched.current) return undefined;
    const d = draft.current;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      setSaving('saving');
      d.inflight = call('PUT', `/${encodeURIComponent(token)}/draft`, { answers, trail })
        .then(() => setSaving('saved'), () => setSaving('failed'));
    }, 1000);
    return () => clearTimeout(d.timer);
  }, [answers, trail, drafting]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (t) => { touched.current = true; setTrail(t); };

  const submit = async (e) => {
    e.preventDefault();
    const need = (pages[page]?.items || []).filter((q) => (q.required && unanswered(q, answers[q.id]) && !(editing && q.type === 'file')) || checkProblem(q.check, answers[q.id])).map((q) => q.id);
    if (form.collect_email && !editing && trail.length === 1 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setEmailMissing(true); document.getElementById('q-email')?.scrollIntoView({ block: 'center' }); return; }
    if (!need.length && after < pages.length) { step([...trail, after]); setMissing([]); window.scrollTo(0, 0); return; } // Next
    setMissing(need);
    if (need.length) { document.getElementById(`q-${need[0]}`)?.scrollIntoView({ block: 'center' }); return; }
    setBusy(true); setSendError('');
    // A draft still being saved mustn't land after the response (sending it deletes the draft).
    clearTimeout(draft.current.timer);
    await draft.current.inflight;
    // File questions hold the uploads ({ id, name }); the form gets their ids.
    const out = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, form.questions.find((q) => q.id === k)?.type === 'file' ? (v || []).map((f) => f.id) : v]));
    try {
      setDone(editing ? await call('PUT', `/${encodeURIComponent(token)}/response/${encodeURIComponent(editing.key)}`, { answers: out }) : await call('POST', `/${encodeURIComponent(token)}`, { answers: out, ...(form.collect_email && { email: email.trim() }) }));
      window.scrollTo(0, 0);
    } catch (err) { setSendError(err.message); } finally { setBusy(false); }
  };

  let body;
  if (error) {
    body = (
      <section className="invite-card stack" role="alert">
        <h1>{error.status === 401 ? 'Sign in to fill in this form' : 'Form not available'}</h1>
        <p className="muted">{error.message}</p>
        {error.status === 401 && onSignIn && <div><button type="button" className="btn primary" onClick={onSignIn}>Sign in</button></div>}
      </section>
    );
  } else if (!form) body = <p className="muted">Loading…</p>;
  else if (done) {
    body = (
      <section className="invite-card stack" aria-live="polite">
        <h1>{form.title}</h1>
        <p style={{ whiteSpace: 'pre-wrap' }}>{done.confirmation || 'Your response has been recorded.'}</p>
        {done.max > 0 && <p className="quiz-score" role="status">Your score: <strong>{done.score} / {done.max}</strong></p>}
        {done.right && (
          <ul className="quiz-review">
            {form.questions.filter((q) => q.id in done.right).map((q) => (
              <li key={q.id}>{done.right[q.id] ? '✓' : '✗'} {q.title || 'Untitled question'}
                {done.feedback?.[q.id] && <span className={`quiz-feedback ${done.right[q.id] ? 'right' : 'wrong'}`}>{done.feedback[q.id]}</span>}</li>
            ))}
          </ul>
        )}
        {done.copy_to && <p className="small" style={{ margin: 0 }}>A copy of your answers is on its way to {done.copy_to}.</p>}
        {done.edit_key && <p className="small" style={{ margin: 0 }}><a href={`/f/${encodeURIComponent(token)}?edit=${encodeURIComponent(done.edit_key)}`}>Change your response</a> <span className="muted">· keep this link to change it later (anyone with it can)</span></p>}
        {!form.one_per_person && !editing && <div><button type="button" className="link-btn" onClick={() => { setDone(null); setAnswers({}); setTrail([0]); }}>Submit another response</button></div>}
      </section>
    );
  } else {
    const closed = !form.accepting || (form.answered && !editing);
    body = (
      <form className="invite-card stack form-fill" onSubmit={submit} noValidate>
        <h1>{form.title}</h1>
        {form.description && <p className="form-desc">{form.description}</p>}
        {form.you && <p className="muted small" style={{ margin: 0 }}>Signed in as {form.you.name} ({form.you.email}). Your name is recorded with your answers.</p>}
        {closed ? <p role="status"><strong>{form.answered && form.accepting ? 'You have already filled in this form.' : form.closed === 'notyet' && form.opens_at ? `This form opens on ${new Date(form.opens_at).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}. Come back then.` : `${form.closed_text || 'This form is no longer accepting responses'}.`}</strong>
          {form.answered && form.accepting && form.my_edit_key && <> <a href={`/f/${encodeURIComponent(token)}?edit=${encodeURIComponent(form.my_edit_key)}`}>Change your response</a></>}</p> : editing && !editing.loaded ? <p className="muted">Loading your response…</p> : <>
          {form.collect_email && !editing && page === 0 && (
            <label id="q-email" className={`field form-fill-q ${emailMissing ? 'missing' : ''}`}>
              <span className="form-fill-title">Your email<span className="req" aria-hidden="true"> *</span></span>
              {form.send_copy && <span className="muted small form-help">A copy of your answers will be sent to it.</span>}
              <input type="email" aria-label="Your email (required)" autoComplete="email" value={email} maxLength={200} onChange={(e) => { setEmail(e.target.value); setEmailMissing(false); }} />
              {emailMissing && <span className="error small" role="alert">Enter your email address</span>}
            </label>
          )}
          {form.send_copy && !form.collect_email && form.you && !editing && page === 0 && <p className="muted small" style={{ margin: 0 }}>A copy of your answers will be emailed to {form.you.email}.</p>}
          {restored && drafting && <p className="banner small" role="status" style={{ margin: 0 }}>Your answers from {new Date(restored).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} are back, as you left them. <button type="button" className="link-btn" onClick={() => { touched.current = true; setAnswers({}); setMissing([]); setTrail([0]); setCleared((n) => n + 1); setRestored(null); }}>Start over</button></p>}
          {editing && <p className="banner small" role="status" style={{ margin: 0 }}>You're changing the response you sent. Send it again to keep the changes.</p>}
          {form.questions.some((q) => q.required) && <p className="muted small" style={{ margin: 0 }}><span className="req">*</span> Required</p>}
          {pages.length > 1 && <p className="muted small form-page-of" style={{ margin: 0 }}>Page {trail.length} · {pages.length} sections</p>}
          {pages[page]?.id && <div className="form-section-head"><h2>{pages[page].title || 'Untitled section'}</h2>{pages[page].help && <p className="muted" style={{ margin: 0 }}>{pages[page].help}</p>}</div>}
          {(pages[page]?.items || []).map((q) => (editing && q.type === 'file'
            ? <div key={q.id} className="form-fill-q"><span className="form-fill-title">{q.title || 'Untitled question'}</span><span className="muted small">{editing.files[q.id]?.length ? `Already sent: ${editing.files[q.id].join(', ')}` : 'No files were sent'} (files can't be changed)</span></div>
            : <Question key={`${q.id}-${cleared}`} q={form.left?.[q.id] ? { ...q, left: form.left[q.id] } : q} token={token} value={answers[q.id]} onChange={(v) => set(q.id, v)} missing={missing.includes(q.id)} />))}
          {sendError && <p className="error small" role="alert">{sendError}</p>}
          <div className="row">
            {trail.length > 1 && <button type="button" className="btn" onClick={() => { step(trail.slice(0, -1)); setMissing([]); }}>Back</button>}
            <button className="btn primary" disabled={busy}>{after < pages.length ? 'Next' : busy ? 'Sending…' : editing ? 'Save changes' : 'Submit'}</button>
            {Object.keys(answers).length > 0 && <button type="button" className="link-btn" onClick={() => { touched.current = true; setAnswers({}); setMissing([]); setTrail([0]); setCleared((n) => n + 1); setRestored(null); }}>Clear form</button>}
            {drafting && saving && <span className="muted small form-draft-state" role="status">{saving === 'saving' ? 'Saving your answers…' : saving === 'saved' ? (Object.keys(answers).length ? 'Your answers are saved: come back to finish any time' : 'Draft deleted') : 'Your answers couldn’t be saved just now'}</span>}</div>
        </>}
        {form.is_owner && <p className="muted small" style={{ margin: 0 }}>This is your form. <a href="/forms">Edit it in Forms</a></p>}
      </form>
    );
  }
  return (
    <div className={`link-page ${new URLSearchParams(window.location.search).has('embed') ? 'embedded' : ''}${form?.theme ? ' form-themed' : ''}`} style={themeStyle(form?.theme)}>
      <header className="link-head" hidden={new URLSearchParams(window.location.search).has('embed')}><div className="brand"><span className="brand-mark">W</span><span className="brand-text">{form?.org_name || 'Workspace'}</span></div></header>
      <main className="link-main">
        {form?.theme?.header && <img className="form-theme-header" src={`/api/public/forms/${encodeURIComponent(token)}/pictures/${form.theme.header}`} alt={form.theme.header_alt || ''} />}
        {body}
      </main>
    </div>
  );
}

/**
 * A signature: drawn in the box (mouse, pen or finger) or typed (for the keyboard), either way kept as
 * a PNG picture. One already given (changing a response) shows, with "Sign again".
 */
function SignatureQuestion({ q, value, onChange, title, help, err, cls, label }) {
  // Until they choose (or start drawing), one already given shows (it may arrive after the page, when changing a response).
  const [chosen, setMode] = useState(null);
  const mode = chosen ?? (value ? 'done' : 'draw');
  const [name, setName] = useState('');
  const pick = (m) => { setMode(m); setName(''); onChange(undefined); };
  return (
    <fieldset id={`q-${q.id}`} className={cls} aria-label={label}>
      <legend>{title}</legend>{help}
      {mode === 'done' && value ? (
        <div className="form-sig-done">
          <img src={value} alt={`Your signature for ${q.title || 'this question'}`} />
          <button type="button" className="link-btn small" onClick={() => pick('draw')}>Sign again</button>
        </div>
      ) : (
        <>
          <div className="row" role="radiogroup" aria-label="How to sign">
            <label className="check"><input type="radio" name={`${q.id}-how`} checked={mode === 'draw'} onChange={() => pick('draw')} /> Draw</label>
            <label className="check"><input type="radio" name={`${q.id}-how`} checked={mode === 'type'} onChange={() => pick('type')} /> Type it instead</label>
          </div>
          {mode === 'draw'
            ? <SignaturePad onChange={async (d) => { setMode('draw'); onChange(d ? (await trimmed(d))?.png : undefined); }} />
            : <>
              <label className="field"><span>Your name, as your signature</span>
                <input value={name} maxLength={80} autoComplete="name" onChange={(e) => { setName(e.target.value); const t = e.target.value.trim(); onChange(t ? textPicture(t, { size: 28, font: SCRIPT_FONT }).png : undefined); }} />
              </label>
              <div className="sign-typed big" aria-hidden="true">{name || '\u00a0'}</div>
            </>}
        </>
      )}
      {err}
    </fieldset>
  );
}

export function Question({ q, token, value, onChange, missing }) {
  const [touched, setTouched] = useState(false); // typed answers are checked once you leave the box
  const [otherOn, setOtherOn] = useState(false); // "Other" chosen (before anything is typed)
  const [otherText, setOtherText] = useState('');
  // "Shuffle option order": each person gets their own order, kept while they fill the form in.
  const order = useMemo(() => (q.shuffle && q.options ? shuffled(q.options) : q.options), [q.shuffle, q.options]);
  const title = <>{q.title || 'Untitled question'}{q.required && <span className="req" aria-hidden="true"> *</span>}</>;
  const picture = q.image && <img className="form-q-picture" src={`/api/public/forms/${encodeURIComponent(token)}/pictures/${q.image}`} alt={q.image_alt || ''} loading="lazy" />;
  const help = (q.help || picture) && <>{q.help && <span className="muted small form-help">{q.help}</span>}{picture}</>;
  const problem = (touched || missing || q.type === 'checkbox') && checkProblem(q.check, value);
  const err = problem ? <span className="error small" role="alert">{problem}</span> : missing && <span className="error small" role="alert">This question needs an answer</span>;
  const cls = `form-fill-q ${missing || problem ? 'missing' : ''}`;
  const label = `${q.title || 'Untitled question'}${q.required ? ' (required)' : ''}`;
  if (q.type === 'rank') {
    // Put the options in order with ↑ ↓ (or drag them). Untouched, it isn't answered yet: "Keep this order" answers as it is.
    const list = Array.isArray(value) && value.length === order.length ? value : order;
    const move = (k, d) => { const next = [...list]; [next[k], next[k + d]] = [next[k + d], next[k]]; onChange(next); };
    return (
      <fieldset id={`q-${q.id}`} className={cls} aria-label={label}>
        <legend>{title}</legend>{help}
        <p className="muted small" style={{ margin: '0 0 6px' }}>Put them in order, your first choice at the top.</p>
        <ol className="form-rank" aria-label={`${q.title || 'Ranking'}: your order`}>
          {list.map((o, k) => (
            <li key={o} className="form-rank-item" draggable onDragStart={(e) => e.dataTransfer.setData('text/x-rank', String(k))}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/x-rank')); if (Number.isInteger(from) && from !== k) { const next = [...list]; const [it] = next.splice(from, 1); next.splice(k, 0, it); onChange(next); } }}>
              <span className="form-rank-n" aria-hidden="true">{k + 1}</span>
              <span className="grow">{o}</span>
              <button type="button" className="icon-btn" aria-label={`Move ${o} up`} disabled={k === 0} onClick={() => move(k, -1)}>↑</button>
              <button type="button" className="icon-btn" aria-label={`Move ${o} down`} disabled={k === list.length - 1} onClick={() => move(k, 1)}>↓</button>
            </li>
          ))}
        </ol>
        {!Array.isArray(value) && <button type="button" className="link-btn small" onClick={() => onChange([...list])}>Keep this order</button>}
        {err}
      </fieldset>
    );
  }
  if (q.type === 'signature') return <SignatureQuestion q={q} value={value} onChange={onChange} title={title} help={help} err={err} cls={cls} label={label} />;
  if (q.type === 'file') return <FileQuestion q={q} token={token} value={value || []} onChange={onChange} title={title} help={help} err={err} cls={cls} label={label} />;
  if (q.type === 'rating') {
    // Stars (or hearts, or thumbs): pick how many; the ones up to the pick fill in.
    const glyph = { star: '★', heart: '♥', thumb: '👍' }[q.icon] || '★';
    const n = Number(value) || 0;
    return (
      <fieldset id={`q-${q.id}`} className={cls} aria-label={label}>
        <legend>{title}</legend>{help}
        <div className="form-rating" role="radiogroup" aria-label={`${q.title || 'Rating'}: ${n ? `${n} of ${q.max}` : 'not rated'}`}>
          {Array.from({ length: q.max }, (_, k) => k + 1).map((k) => (
            <label key={k} className={`form-rating-pick ${k <= n ? 'on' : ''}`} title={`${k} of ${q.max}`}>
              <input type="radio" name={q.id} value={k} checked={n === k} aria-label={`${k} of ${q.max}`} onChange={() => onChange(k)} />
              <span aria-hidden="true">{glyph}</span>
            </label>
          ))}
        </div>
        {!q.required && n > 0 && <button type="button" className="link-btn small" onClick={() => onChange(undefined)}>Clear selection</button>}
        {err}
      </fieldset>
    );
  }
  if (q.type === 'grid' || q.type === 'checkgrid') {
    const many = q.type === 'checkgrid';
    const v = value || {};
    const pick = (row, c, on) => {
      const next = { ...v };
      if (many) { const l = (v[row] || []).filter((x) => x !== c); next[row] = on ? q.columns.filter((x) => x === c || l.includes(x)) : l; if (!next[row].length) delete next[row]; }
      else next[row] = c;
      onChange(Object.keys(next).length ? next : undefined);
    };
    return (
      <fieldset id={`q-${q.id}`} className={cls} aria-label={label}>
        <legend>{title}</legend>{help}
        <div className="form-grid-wrap"><table className="form-grid">
          <thead><tr><th />{q.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>{q.rows.map((row) => (
            <tr key={row} role="group" aria-label={row}><th scope="row">{row}</th>
              {q.columns.map((c) => <td key={c}><input type={many ? 'checkbox' : 'radio'} name={`${q.id}-${row}`} aria-label={`${row}: ${c}`}
                checked={many ? (v[row] || []).includes(c) : v[row] === c} onChange={(e) => pick(row, c, e.target.checked)} /></td>)}
            </tr>))}</tbody>
        </table></div>
        {missing && <span className="error small" role="alert">Answer every row</span>}
      </fieldset>
    );
  }
  if (q.type === 'choice' || q.type === 'checkbox' || q.type === 'scale') {
    const opts = q.type === 'scale' ? Array.from({ length: q.max }, (_, i) => String(i + 1)) : order;
    const many = q.type === 'checkbox';
    const list = many ? value || [] : [];
    // "Other": what they typed is the answer (with the options they ticked, for tick boxes).
    const typed = q.other ? (many ? list.find((x) => !q.options.includes(x)) : value !== undefined && value !== '' && !q.options.includes(String(value)) ? String(value) : undefined) : undefined;
    const picked = many ? list.filter((x) => q.options.includes(x)) : [];
    const setOther = (on, text) => {
      setOtherText(text);
      setOtherOn(on);
      if (many) onChange([...picked, ...(on && text.trim() ? [text] : [])]);
      else onChange(on ? (text.trim() ? text : undefined) : undefined);
    };
    const otherChecked = otherOn || typed !== undefined;
    return (
      <fieldset id={`q-${q.id}`} className={cls} aria-label={label}>
        <legend>{title}</legend>{help}
        <div className={q.type === 'scale' ? 'form-scale' : 'stack-tight'}>
          {q.type === 'scale' && q.low && <span className="muted small">{q.low}</span>}
          {opts.map((o) => {
            const on = many ? list.includes(o) : String(value ?? '') === o;
            const places = q.left?.[o]; // limited options: how many places are left
            const full = places === 0 && !on;
            return (
              <label key={o} className={`${q.type === 'scale' ? 'form-scale-pick' : 'check'} ${full ? 'form-full' : ''}`}>
                <input type={many ? 'checkbox' : 'radio'} name={q.id} value={o} checked={on} disabled={full}
                  onChange={(e) => { if (!many) setOtherOn(false); return many ? onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o)) : onChange(q.type === 'scale' ? Number(o) : o); }} />
                <span className={q.option_images?.[o] ? 'form-option-pic' : undefined}>{q.option_images?.[o] && <img src={`/api/public/forms/${encodeURIComponent(token)}/pictures/${q.option_images[o]}`} alt="" loading="lazy" />}
                  <span>{o}{places !== undefined && <span className="muted small"> · {places === 0 ? 'Full' : `${places} ${places === 1 ? 'place' : 'places'} left`}</span>}</span></span>
              </label>
            );
          })}
          {q.type === 'scale' && q.high && <span className="muted small">{q.high}</span>}
          {q.other && (
            <span className="check form-other">
              <input type={many ? 'checkbox' : 'radio'} name={q.id} aria-label="Other" checked={otherChecked}
                onChange={(e) => setOther(many ? e.target.checked : true, typed ?? otherText)} />
              <span>Other:</span>
              <input className="grow" aria-label={`${q.title || 'Question'}: other answer`} value={typed ?? otherText} maxLength={200}
                onChange={(e) => setOther(true, e.target.value)} />
            </span>
          )}
        </div>
        {!many && !q.required && value !== undefined && value !== '' && <button type="button" className="link-btn small" onClick={() => onChange(undefined)}>Clear selection</button>}
        {err}
      </fieldset>
    );
  }
  return (
    <label id={`q-${q.id}`} className={`field ${cls}`}>
      <span className="form-fill-title">{title}</span>{help}
      {q.type === 'paragraph' ? <textarea rows={4} maxLength={5000} aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} onBlur={() => setTouched(true)} />
        : q.type === 'dropdown' ? (
          <select aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose</option>{order.map((o) => { const places = q.left?.[o]; return <option key={o} value={o} disabled={places === 0 && value !== o}>{o}{places !== undefined ? ` (${places === 0 ? 'full' : `${places} left`})` : ''}</option>; })}
          </select>
        ) : <input type={q.type === 'date' ? 'date' : q.type === 'time' ? 'time' : 'text'} inputMode={q.check?.kind === 'number' ? 'decimal' : q.check?.op === 'email' ? 'email' : undefined} maxLength={500} aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} onBlur={() => setTouched(true)} />}
      {err}
    </label>
  );
}

/** A file upload question: each file is sent when it's picked (up to 10 MB), and listed with ×. */
function FileQuestion({ q, token, value, onChange, title, help, err, cls, label }) {
  const [busy, setBusy] = useState(0);
  const [problem, setProblem] = useState('');
  const max = q.max_files || 1;
  const mb = q.max_mb || 10;
  const add = async (files) => {
    setProblem('');
    let list = value;
    for (const file of [...files].slice(0, max - list.length)) {
      // The question's own limits (kinds of file, size), checked here first; the server checks again (contents too).
      const exts = (q.accept_attr || '').split(',').filter(Boolean);
      const ext = (/\.[a-z0-9]{1,8}$/i.exec(file.name)?.[0] || '').toLowerCase();
      if (exts.length && !exts.includes(ext)) { setProblem(`${file.name} can't be sent here: this question only takes ${q.accept_text}`); continue; }
      if (file.size > mb * 1024 * 1024) { setProblem(`${file.name} is too large: files can be up to ${mb} MB`); continue; }
      setBusy((n) => n + 1);
      try {
        const r = await fetch(`/api/public/forms/${encodeURIComponent(token)}/upload?name=${encodeURIComponent(file.name)}&question=${encodeURIComponent(q.id)}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'nas-workspace', 'content-type': file.type || 'application/octet-stream' }, body: file });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.error || 'The file could not be sent');
        list = [...list, b];
        onChange(list);
      } catch (e) { setProblem(e.message); } finally { setBusy((n) => n - 1); }
    }
  };
  return (
    <fieldset id={`q-${q.id}`} className={cls} aria-label={label}>
      <legend>{title}</legend>{help}
      {value.length > 0 && (
        <ul className="form-files" aria-label="Files you've added">
          {value.map((f) => <li key={f.id} className="row"><span className="grow ellipsis">📎 {f.name}</span><button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => onChange(value.filter((x) => x.id !== f.id))}>×</button></li>)}
        </ul>
      )}
      {value.length < max && (
        <label className="btn" style={{ alignSelf: 'flex-start' }}>
          {busy ? 'Sending…' : value.length ? 'Add another file' : 'Add file'}
          <input type="file" hidden multiple={max > 1} accept={q.accept_attr || undefined} aria-label={`Add a file: ${label}`} disabled={busy > 0} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        </label>
      )}
      <span className="muted small">{q.accept?.length ? `${q.accept_text || requestSummary({ accept: q.accept }).replace(/^Takes /, '')}: up` : 'Up'} to {max === 1 ? '1 file' : `${max} files`}, {mb} MB each</span>
      {problem && <span className="error small" role="alert">{problem}</span>}
      {err}
    </fieldset>
  );
}
