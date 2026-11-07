// The page people fill a form in on (/f/<token>). Company forms need the visitor signed in to that
// company (they can sign in right here); "anyone with the link" forms need nothing.
import { useEffect, useState } from 'react';

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
  const [missing, setMissing] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [done, setDone] = useState(null);
  const load = () => call('GET', `/${encodeURIComponent(token)}`).then((f) => { setForm(f); setError(null); }).catch((e) => setError({ status: e.status, message: e.message }));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = form?.title || 'Form'; }, [form?.title]);

  const set = (id, v) => { setAnswers((a) => ({ ...a, [id]: v })); setMissing((m) => m.filter((x) => x !== id)); };
  const submit = async (e) => {
    e.preventDefault();
    const need = form.questions.filter((q) => q.required && empty(answers[q.id])).map((q) => q.id);
    setMissing(need);
    if (need.length) { document.getElementById(`q-${need[0]}`)?.scrollIntoView({ block: 'center' }); return; }
    setBusy(true); setSendError('');
    try { setDone(await call('POST', `/${encodeURIComponent(token)}`, { answers })); window.scrollTo(0, 0); } catch (err) { setSendError(err.message); } finally { setBusy(false); }
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
        {!form.one_per_person && <div><button type="button" className="link-btn" onClick={() => { setDone(null); setAnswers({}); }}>Submit another response</button></div>}
      </section>
    );
  } else {
    const closed = !form.accepting || form.answered;
    body = (
      <form className="invite-card stack form-fill" onSubmit={submit} noValidate>
        <h1>{form.title}</h1>
        {form.description && <p className="form-desc">{form.description}</p>}
        {form.you && <p className="muted small" style={{ margin: 0 }}>Signed in as {form.you.name} ({form.you.email}). Your name is recorded with your answers.</p>}
        {closed ? <p role="status"><strong>{form.answered ? 'You have already filled in this form.' : `${form.closed_text || 'This form is no longer accepting responses'}.`}</strong></p> : <>
          {form.questions.some((q) => q.required) && <p className="muted small" style={{ margin: 0 }}><span className="req">*</span> Required</p>}
          {form.questions.map((q) => <Question key={q.id} q={q} value={answers[q.id]} onChange={(v) => set(q.id, v)} missing={missing.includes(q.id)} />)}
          {sendError && <p className="error small" role="alert">{sendError}</p>}
          <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Submit'}</button>
            {Object.keys(answers).length > 0 && <button type="button" className="link-btn" onClick={() => { setAnswers({}); setMissing([]); }}>Clear form</button>}</div>
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

function Question({ q, value, onChange, missing }) {
  const title = <>{q.title || 'Untitled question'}{q.required && <span className="req" aria-hidden="true"> *</span>}</>;
  const help = q.help && <span className="muted small form-help">{q.help}</span>;
  const err = missing && <span className="error small" role="alert">This question needs an answer</span>;
  const cls = `form-fill-q ${missing ? 'missing' : ''}`;
  const label = `${q.title || 'Untitled question'}${q.required ? ' (required)' : ''}`;
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
      {q.type === 'paragraph' ? <textarea rows={4} maxLength={5000} aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} />
        : q.type === 'dropdown' ? (
          <select aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose</option>{q.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : <input type={q.type === 'date' ? 'date' : 'text'} maxLength={500} aria-label={label} value={value || ''} onChange={(e) => onChange(e.target.value)} />}
      {err}
    </label>
  );
}
