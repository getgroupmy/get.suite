// The page people fill a form in on (/f/<token>). Company forms need the visitor signed in to that
// company (they can sign in right here); "anyone with the link" forms need nothing.
import { checkProblem } from './formcheck.js';
import { useEffect, useState } from 'react';
import { sectionsOf, nextPage } from './formmath.js';

async function call(method, url, body) {
  const res = await fetch(`/api/public/forms${url}`, {
    method, headers: { 'x-requested-with': 'nas-workspace', ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const empty = (a) => a === undefined || a === '' || (Array.isArray(a) && !a.length);

export default function FormRespond({ token, onSignIn }) {
  const [form, setForm] = useState(null);
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
  const load = () => call('GET', `/${encodeURIComponent(token)}`).then((f) => { setForm(f); setError(null); }).catch((e) => setError({ status: e.status, message: e.message }));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = form?.title || 'Form'; }, [form?.title]);

  const set = (id, v) => { setAnswers((a) => ({ ...a, [id]: v })); setMissing((m) => m.filter((x) => x !== id)); };
  const pages = form ? sectionsOf(form.questions) : [];
  const page = trail[trail.length - 1];
  const after = form ? nextPage(pages, Math.min(page, pages.length - 1), answers) : 0;
  const submit = async (e) => {
    e.preventDefault();
    const need = (pages[page]?.items || []).filter((q) => (q.required && empty(answers[q.id]) && !(editing && q.type === 'file')) || checkProblem(q.check, answers[q.id])).map((q) => q.id);
    if (form.collect_email && !editing && trail.length === 1 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setEmailMissing(true); document.getElementById('q-email')?.scrollIntoView({ block: 'center' }); return; }
    if (!need.length && after < pages.length) { setTrail([...trail, after]); setMissing([]); window.scrollTo(0, 0); return; } // Next
    setMissing(need);
    if (need.length) { document.getElementById(`q-${need[0]}`)?.scrollIntoView({ block: 'center' }); return; }
    setBusy(true); setSendError('');
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
            {form.questions.filter((q) => q.id in done.right).map((q) => <li key={q.id}>{done.right[q.id] ? '✓' : '✗'} {q.title || 'Untitled question'}</li>)}
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
        {closed ? <p role="status"><strong>{form.answered && form.accepting ? 'You have already filled in this form.' : `${form.closed_text || 'This form is no longer accepting responses'}.`}</strong>
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
          {editing && <p className="banner small" role="status" style={{ margin: 0 }}>You're changing the response you sent. Send it again to keep the changes.</p>}
          {form.questions.some((q) => q.required) && <p className="muted small" style={{ margin: 0 }}><span className="req">*</span> Required</p>}
          {pages.length > 1 && <p className="muted small form-page-of" style={{ margin: 0 }}>Page {trail.length} · {pages.length} sections</p>}
          {pages[page]?.id && <div className="form-section-head"><h2>{pages[page].title || 'Untitled section'}</h2>{pages[page].help && <p className="muted" style={{ margin: 0 }}>{pages[page].help}</p>}</div>}
          {(pages[page]?.items || []).map((q) => (editing && q.type === 'file'
            ? <div key={q.id} className="form-fill-q"><span className="form-fill-title">{q.title || 'Untitled question'}</span><span className="muted small">{editing.files[q.id]?.length ? `Already sent: ${editing.files[q.id].join(', ')}` : 'No files were sent'} (files can't be changed)</span></div>
            : <Question key={q.id} q={q} token={token} value={answers[q.id]} onChange={(v) => set(q.id, v)} missing={missing.includes(q.id)} />))}
          {sendError && <p className="error small" role="alert">{sendError}</p>}
          <div className="row">
            {trail.length > 1 && <button type="button" className="btn" onClick={() => { setTrail(trail.slice(0, -1)); setMissing([]); }}>Back</button>}
            <button className="btn primary" disabled={busy}>{after < pages.length ? 'Next' : busy ? 'Sending…' : editing ? 'Save changes' : 'Submit'}</button>
            {Object.keys(answers).length > 0 && <button type="button" className="link-btn" onClick={() => { setAnswers({}); setMissing([]); setTrail([0]); }}>Clear form</button>}</div>
        </>}
        {form.is_owner && <p className="muted small" style={{ margin: 0 }}>This is your form. <a href="/forms">Edit it in Forms</a></p>}
      </form>
    );
  }
  return (
    <div className="link-page">
      <header className="link-head"><div className="brand"><span className="brand-mark">W</span><span className="brand-text">{form?.org_name || 'Workspace'}</span></div></header>
      <main className="link-main">{body}</main>
    </div>
  );
}

function Question({ q, token, value, onChange, missing }) {
  const [touched, setTouched] = useState(false); // typed answers are checked once you leave the box
  const title = <>{q.title || 'Untitled question'}{q.required && <span className="req" aria-hidden="true"> *</span>}</>;
  const help = q.help && <span className="muted small form-help">{q.help}</span>;
  const problem = (touched || missing || q.type === 'checkbox') && checkProblem(q.check, value);
  const err = problem ? <span className="error small" role="alert">{problem}</span> : missing && <span className="error small" role="alert">This question needs an answer</span>;
  const cls = `form-fill-q ${missing || problem ? 'missing' : ''}`;
  const label = `${q.title || 'Untitled question'}${q.required ? ' (required)' : ''}`;
  if (q.type === 'file') return <FileQuestion q={q} token={token} value={value || []} onChange={onChange} title={title} help={help} err={err} cls={cls} label={label} />;
  if (q.type === 'choice' || q.type === 'checkbox' || q.type === 'scale') {
    const opts = q.type === 'scale' ? Array.from({ length: q.max }, (_, i) => String(i + 1)) : q.options;
    const many = q.type === 'checkbox';
    const list = many ? value || [] : [];
    return (
      <fieldset id={`q-${q.id}`} className={cls} aria-label={label}>
        <legend>{title}</legend>{help}
        <div className={q.type === 'scale' ? 'form-scale' : 'stack-tight'}>
          {q.type === 'scale' && q.low && <span className="muted small">{q.low}</span>}
          {opts.map((o) => (
            <label key={o} className={q.type === 'scale' ? 'form-scale-pick' : 'check'}>
              <input type={many ? 'checkbox' : 'radio'} name={q.id} value={o}
                checked={many ? list.includes(o) : String(value ?? '') === o}
                onChange={(e) => (many ? onChange(e.target.checked ? [...list, o] : list.filter((x) => x !== o)) : onChange(q.type === 'scale' ? Number(o) : o))} />
              <span>{o}</span>
            </label>
          ))}
          {q.type === 'scale' && q.high && <span className="muted small">{q.high}</span>}
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
            <option value="">Choose</option>{q.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : <input type={q.type === 'date' ? 'date' : 'text'} inputMode={q.check?.kind === 'number' ? 'decimal' : q.check?.op === 'email' ? 'email' : undefined} maxLength={500} aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} onBlur={() => setTouched(true)} />}
      {err}
    </label>
  );
}

/** A file upload question: each file is sent when it's picked (up to 10 MB), and listed with ×. */
function FileQuestion({ q, token, value, onChange, title, help, err, cls, label }) {
  const [busy, setBusy] = useState(0);
  const [problem, setProblem] = useState('');
  const max = q.max_files || 1;
  const add = async (files) => {
    setProblem('');
    let list = value;
    for (const file of [...files].slice(0, max - list.length)) {
      if (file.size > 10 * 1024 * 1024) { setProblem(`${file.name} is larger than 10 MB`); continue; }
      setBusy((n) => n + 1);
      try {
        const r = await fetch(`/api/public/forms/${encodeURIComponent(token)}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'x-requested-with': 'nas-workspace', 'content-type': file.type || 'application/octet-stream' }, body: file });
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
          <input type="file" hidden multiple={max > 1} aria-label={`Add a file: ${label}`} disabled={busy > 0} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        </label>
      )}
      <span className="muted small">Up to {max === 1 ? '1 file' : `${max} files`}, 10 MB each</span>
      {problem && <span className="error small" role="alert">{problem}</span>}
      {err}
    </fieldset>
  );
}
