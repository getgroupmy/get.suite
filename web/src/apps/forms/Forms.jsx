// Forms: build a questionnaire, share its link, read the answers. /forms lists yours; /forms/:id edits one
// (Questions, Responses, Settings). People fill it in at /f/<token> (FormRespond.jsx).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, post, put, del, onLive, formatDate } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, Empty, Menu, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { TYPES, HAS_OPTIONS, newId, retype, nextOption, summarize, percent } from './formmath.js';

export default function Forms() {
  const { id } = useParams();
  return id ? <FormEditor key={id} id={id} /> : <FormList />;
}

const linkOf = (token) => `${window.location.origin}/f/${token}`;

function FormList() {
  const navigate = useNavigate();
  const toast = useToast();
  const [forms, setForms] = useState(null);
  useEffect(() => { get('/forms').then(setForms).catch((e) => toast(e.message, 'error')); }, [toast]);
  const create = async () => {
    try { navigate(`/forms/${(await post('/forms', { title: 'Untitled form' })).id}`); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1 className="grow">Forms</h1><button type="button" className="btn primary" onClick={create}><Icon name="plus" size={18} /> New form</button></div>
      {forms === null ? <p className="muted">Loading…</p> : !forms.length ? (
        <Empty icon="form" title="No forms yet">Make a sign-up sheet, a survey or a quick poll, share its link and see the answers come in.</Empty>
      ) : (
        <ul className="form-list" aria-label="Your forms">
          {forms.map((f) => (
            <li key={f.id}>
              <button type="button" className="form-row" onClick={() => navigate(`/forms/${f.id}`)}>
                <Icon name="form" />
                <span className="grow"><span className="form-row-title">{f.title}</span>
                  <span className="muted small">{f.responses === 1 ? '1 response' : `${f.responses} responses`}{f.last_response ? ` · last ${formatDate(f.last_response)}` : ''}</span></span>
                {!f.accepting && <span className="tag">Closed</span>}
                {f.audience === 'public' && <span className="tag">Anyone with the link</span>}
                <span className="muted small nowrap">Edited {formatDate(f.updated_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FormEditor({ id }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'questions';
  const setTab = (t) => setParams(t === 'questions' ? {} : { tab: t }, { replace: true });
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [responses, setResponses] = useState(null);

  useEffect(() => { get(`/forms/${id}`).then(setForm).catch((e) => setError(e.message)); }, [id]);
  const loadResponses = useCallback(() => get(`/forms/${id}/responses`).then((r) => setResponses(r.responses)).catch(() => {}), [id]);
  useEffect(() => { loadResponses(); }, [loadResponses]);
  useEffect(() => onLive((m) => { if (m.type === 'form-response' && m.form_id === id) loadResponses(); }), [id, loadResponses]);
  useEffect(() => { if (form?.title) document.title = `${form.title} – Forms`; }, [form?.title]);

  // Typing saves itself shortly after; leaving the page sends what's waiting.
  const pending = useRef(null);
  const timer = useRef(null);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const body = pending.current;
    if (!body) return;
    pending.current = null;
    setStatus('Saving…');
    try { await put(`/forms/${id}`, body); setStatus('Saved'); } catch (e) { setStatus(''); toast(e.message, 'error'); }
  }, [id, toast]);
  useEffect(() => () => { flush(); }, [flush]);
  const edit = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    pending.current = { ...pending.current, ...patch };
    setStatus('Saving…');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };
  // Settings save straight away and take the server's answer.
  const setting = async (patch) => {
    await flush();
    const before = form;
    setForm((f) => ({ ...f, ...patch })); // tick boxes move straight away
    try { setForm(await put(`/forms/${id}`, patch)); setStatus('Saved'); } catch (e) { setForm(before); toast(e.message, 'error'); }
  };

  if (error) return <div className="page"><Empty icon="form" title="Form not available">{error}</Empty></div>;
  if (!form) return <div className="page"><p className="muted">Loading…</p></div>;

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(linkOf(form.token)); toast('Link copied'); } catch { toast(linkOf(form.token)); }
  };
  const copyForm = async () => {
    await flush();
    try { const c = await post(`/forms/${id}/copy`); toast('Copy made'); navigate(`/forms/${c.id}`); } catch (e) { toast(e.message, 'error'); }
  };
  const count = responses?.length ?? form.responses ?? 0;
  return (
    <div className="page form-editor">
      <div className="page-head">
        <button type="button" className="icon-btn" aria-label="All forms" onClick={() => navigate('/forms')}><Icon name="back" /></button>
        <input className="form-title-input grow" aria-label="Form title" value={form.title} maxLength={200} onChange={(e) => edit({ title: e.target.value })} />
        <span className="muted small nowrap" aria-live="polite">{status}</span>
        <button type="button" className="btn" onClick={copyLink}><Icon name="link" size={18} /> Copy link</button>
        <a className="btn" href={`/f/${form.token}`} target="_blank" rel="noreferrer">Preview</a>
        <Menu trigger={(p) => <button className="icon-btn" aria-label="More" {...p}><Icon name="more" /></button>} items={[
          { label: 'Make a copy', icon: 'copy', onClick: copyForm },
          { label: 'Delete form', icon: 'trash', onClick: () => setConfirm(true) },
        ]} />
      </div>
      <div className="tabs" role="tablist" style={{ alignSelf: 'flex-start' }}>
        {[['questions', 'Questions'], ['responses', `Responses (${count})`], ['settings', 'Settings']].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'questions' && <QuestionsTab form={form} edit={edit} />}
      {tab === 'responses' && <ResponsesTab form={form} responses={responses} reload={loadResponses} setting={setting} flush={flush} />}
      {tab === 'settings' && <SettingsTab form={form} setting={setting} orgName={user.org_name} allowLinks={user.allow_links} />}
      {confirm && <ConfirmModal title="Delete this form?" message={`“${form.title}” and its ${count === 1 ? 'response' : `${count} responses`} will be deleted, and its link will stop working.`}
        onClose={() => setConfirm(false)} onConfirm={async () => { pending.current = null; await del(`/forms/${id}`); navigate('/forms'); }} />}
    </div>
  );
}

function QuestionsTab({ form, edit }) {
  const qs = form.questions;
  const setQs = (next) => edit({ questions: next });
  const change = (i, patch) => setQs(qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i, d) => { const next = qs.slice(); [next[i], next[i + d]] = [next[i + d], next[i]]; setQs(next); };
  const add = () => setQs([...qs, retype({ id: newId() }, 'choice')]);
  return (
    <div className="stack form-questions">
      <label className="field"><span>Description</span>
        <textarea rows={2} value={form.description} maxLength={5000} placeholder="What it's for, shown at the top of the form" onChange={(e) => edit({ description: e.target.value })} /></label>
      {!qs.length && <p className="muted">No questions yet.</p>}
      {qs.map((q, i) => (
        <section key={q.id} className="card form-q" aria-label={`Question ${i + 1}`}>
          <div className="row wrap">
            <input className="grow form-q-title" aria-label={`Question ${i + 1} title`} placeholder="Question" value={q.title} maxLength={300} onChange={(e) => change(i, { title: e.target.value })} />
            <select aria-label={`Type of question ${i + 1}`} value={q.type} onChange={(e) => setQs(qs.map((x, j) => (j === i ? retype(x, e.target.value) : x)))}>
              {TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          <input className="form-q-help" aria-label={`Help text for question ${i + 1}`} placeholder="Help text (optional)" value={q.help || ''} maxLength={1000} onChange={(e) => change(i, { help: e.target.value })} />
          {HAS_OPTIONS.has(q.type) && (
            <ul className="form-options">
              {q.options.map((o, k) => (
                <li key={k} className="row">
                  <span className="form-option-mark" aria-hidden="true">{q.type === 'choice' ? '○' : q.type === 'checkbox' ? '☐' : `${k + 1}.`}</span>
                  <input className="grow" aria-label={`Question ${i + 1}, option ${k + 1}`} value={o} maxLength={200} onChange={(e) => change(i, { options: q.options.map((x, m) => (m === k ? e.target.value : x)) })} />
                  {q.options.length > 1 && <button type="button" className="icon-btn" aria-label={`Remove option ${k + 1}`} onClick={() => change(i, { options: q.options.filter((_, m) => m !== k) })}><Icon name="close" size={16} /></button>}
                </li>
              ))}
              {q.options.length < 50 && <li><button type="button" className="link-btn" onClick={() => change(i, { options: [...q.options, nextOption(q.options)] })}>Add option</button></li>}
            </ul>
          )}
          {q.type === 'scale' && (
            <div className="row wrap">
              <label className="row small">1 to <select aria-label={`Scale of question ${i + 1}`} value={q.max} onChange={(e) => change(i, { max: Number(e.target.value) })}><option value={5}>5</option><option value={10}>10</option></select></label>
              <input aria-label={`Label for 1, question ${i + 1}`} placeholder="Label for 1 (optional)" value={q.low || ''} maxLength={60} onChange={(e) => change(i, { low: e.target.value })} />
              <input aria-label={`Label for ${q.max}, question ${i + 1}`} placeholder={`Label for ${q.max} (optional)`} value={q.high || ''} maxLength={60} onChange={(e) => change(i, { high: e.target.value })} />
            </div>
          )}
          {(q.type === 'short' || q.type === 'paragraph' || q.type === 'date') && <p className="muted small form-q-sample">{q.type === 'date' ? 'They pick a date' : q.type === 'short' ? 'Short answer text' : 'Long answer text'}</p>}
          <div className="row form-q-foot">
            <label className="check grow"><input type="checkbox" checked={q.required} onChange={(e) => change(i, { required: e.target.checked })} /> Required</label>
            <button type="button" className="icon-btn" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="icon-btn" aria-label={`Move question ${i + 1} down`} disabled={i === qs.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="icon-btn" aria-label={`Duplicate question ${i + 1}`} onClick={() => setQs([...qs.slice(0, i + 1), { ...q, id: newId() }, ...qs.slice(i + 1)])}><Icon name="copy" size={18} /></button>
            <button type="button" className="icon-btn" aria-label={`Delete question ${i + 1}`} onClick={() => setQs(qs.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
          </div>
        </section>
      ))}
      {qs.length < 100 && <div><button type="button" className="btn" onClick={add}><Icon name="plus" size={18} /> Add question</button></div>}
    </div>
  );
}

function ResponsesTab({ form, responses, reload, setting, flush }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [view, setView] = useState('summary');
  const [at, setAt] = useState(0);
  const [clear, setClear] = useState(false);
  if (!responses) return <p className="muted">Loading…</p>;
  const toSheet = async () => {
    await flush();
    try { const r = await post(`/forms/${form.id}/sheet`); toast('Responses copied to a new spreadsheet in your Drive'); navigate(`/sheets/${r.id}`); } catch (e) { toast(e.message, 'error'); }
  };
  const one = responses[Math.min(at, responses.length - 1)];
  return (
    <div className="stack">
      <div className="row wrap">
        <strong className="grow">{responses.length === 1 ? '1 response' : `${responses.length} responses`}</strong>
        <label className="check"><input type="checkbox" checked={form.accepting} onChange={(e) => setting({ accepting: e.target.checked })} /> Accepting responses</label>
        <a className="btn" href={`/api/forms/${form.id}/responses.csv`} download>Download CSV</a>
        <button type="button" className="btn" onClick={toSheet}><Icon name="sheet" size={18} /> Open in Sheets</button>
        {responses.length > 0 && <button type="button" className="btn" onClick={() => setClear(true)}>Delete all</button>}
      </div>
      {!form.accepting && <p className="muted small" style={{ margin: 0 }}>This form is closed: people who open the link are told it isn't accepting responses.</p>}
      {!responses.length ? <Empty icon="form" title="No responses yet">Share the link (<strong>Copy link</strong> at the top) and answers show up here as they come in.</Empty> : <>
        <div className="tabs" role="tablist" aria-label="Show" style={{ alignSelf: 'flex-start' }}>
          <button type="button" role="tab" aria-selected={view === 'summary'} className={view === 'summary' ? 'on' : ''} onClick={() => setView('summary')}>Summary</button>
          <button type="button" role="tab" aria-selected={view === 'one'} className={view === 'one' ? 'on' : ''} onClick={() => setView('one')}>Individual</button>
        </div>
        {view === 'summary' ? summarize(form.questions, responses).map((s) => (
          <section key={s.id} className="card form-summary" aria-label={`Summary: ${s.title || 'Untitled question'}`}>
            <h3>{s.title || 'Untitled question'}</h3>
            <p className="muted small">{s.answered === 1 ? '1 answer' : `${s.answered} answers`}{s.average !== undefined ? ` · average ${s.average}` : ''}</p>
            {s.bars ? (
              <ul className="form-bars">
                {s.bars.map((b) => (
                  <li key={b.label}><span className="form-bar-label">{b.label}</span>
                    <span className="form-bar"><span style={{ width: percent(b.share) }} /></span>
                    <span className="small nowrap">{b.count} ({percent(b.share)})</span></li>
                ))}
              </ul>
            ) : (
              <ul className="form-texts">{s.texts.slice(0, 100).map((t, k) => <li key={k}>{t}</li>)}{s.texts.length > 100 && <li className="muted small">and {s.texts.length - 100} more (download the CSV for all of them)</li>}</ul>
            )}
          </section>
        )) : (
          <section className="card stack" aria-label="Response">
            <div className="row">
              <button type="button" className="icon-btn" aria-label="Previous response" disabled={at === 0} onClick={() => setAt(at - 1)}>‹</button>
              <span className="grow small">{Math.min(at, responses.length - 1) + 1} of {responses.length} · {formatDate(one.created_at)}{one.user ? ` · ${one.user.name} (${one.user.email})` : ''}</span>
              <button type="button" className="icon-btn" aria-label="Next response" disabled={at >= responses.length - 1} onClick={() => setAt(at + 1)}>›</button>
              <button type="button" className="icon-btn" aria-label="Delete this response" onClick={async () => { await del(`/forms/${form.id}/responses/${one.id}`); setAt(Math.max(0, at - 1)); reload(); }}><Icon name="trash" size={18} /></button>
            </div>
            {form.questions.map((q) => {
              const a = one.answers[q.id];
              return <div key={q.id}><strong>{q.title || 'Untitled question'}</strong><p className={a === undefined ? 'muted' : ''} style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{a === undefined ? 'No answer' : Array.isArray(a) ? a.join(', ') : String(a)}</p></div>;
            })}
          </section>
        )}
      </>}
      {clear && <ConfirmModal title="Delete all responses?" message={`All ${responses.length} responses will be deleted. Download the CSV first if you want to keep them.`}
        onClose={() => setClear(false)} onConfirm={async () => { await del(`/forms/${form.id}/responses`); setAt(0); reload(); }} />}
    </div>
  );
}

function SettingsTab({ form, setting, orgName, allowLinks }) {
  const toast = useToast();
  const [confirmation, setConfirmation] = useState(form.confirmation);
  return (
    <div className="stack form-settings">
      <fieldset className="stack-tight">
        <legend>Who can fill it in</legend>
        <label className="check"><input type="radio" name="aud" checked={form.audience === 'org'} onChange={() => setting({ audience: 'org' })} /> People at {orgName} (they sign in; their name is recorded)</label>
        <label className="check"><input type="radio" name="aud" checked={form.audience === 'public'} disabled={!allowLinks && form.audience !== 'public'} onChange={() => setting({ audience: 'public' })} /> Anyone with the link (no sign-in; anonymous)</label>
        {!allowLinks && <p className="muted small">Your company has turned off links for people outside it.</p>}
      </fieldset>
      {form.audience === 'org' && <label className="check"><input type="checkbox" checked={form.one_per_person} onChange={(e) => setting({ one_per_person: e.target.checked })} /> One response per person</label>}
      <label className="check"><input type="checkbox" checked={form.notify} onChange={(e) => setting({ notify: e.target.checked })} /> Notify me of each new response</label>
      <label className="field"><span>Message after submitting</span>
        <textarea rows={2} maxLength={1000} value={confirmation} placeholder="Your response has been recorded." onChange={(e) => setConfirmation(e.target.value)}
          onBlur={() => confirmation !== form.confirmation && setting({ confirmation })} /></label>
      <div className="stack-tight">
        <span className="small"><strong>Link:</strong> <code>{linkOf(form.token)}</code></span>
        <div><button type="button" className="btn" onClick={async () => {
            try { await post(`/forms/${form.id}/new-link`); await setting({}); toast('New link made; the old one no longer works'); } catch (e) { toast(e.message, 'error'); }
          }}>Get a new link</button></div>
        <p className="muted small" style={{ margin: 0 }}>A new link stops the old one working, if it went somewhere it shouldn't.</p>
      </div>
    </div>
  );
}
