// Forms: build a questionnaire, share its link, read the answers. /forms lists yours; /forms/:id edits one
// (Questions, Responses, Settings). People fill it in at /f/<token> (FormRespond.jsx).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, post, put, del, onLive, formatDate, uploadFile } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, Empty, Menu, Modal, useToast } from '../../components/ui.jsx';
import { Question } from './FormRespond.jsx';
import { EmbedCode } from '../editorCommon.jsx';
import { useAuth } from '../../App.jsx';
import QRCode from 'qrcode';
import { TYPES, HAS_OPTIONS, GRIDS, MAX_RANKED, prefillParam, newId, retype, nextOption, summarize, percent } from './formmath.js';
import { CHECKS, OPS, KIND_NAMES, cleanCheck } from './formcheck.js';

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
  const [templates, setTemplates] = useState([]);
  useEffect(() => { get('/forms/templates').then(setTemplates).catch(() => {}); }, []);
  const create = async (template) => {
    try { navigate(`/forms/${(await post('/forms', template ? { template } : { title: 'Untitled form' })).id}`); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1 className="grow">Forms</h1><button type="button" className="btn primary" onClick={() => create()}><Icon name="plus" size={18} /> New form</button></div>
      {templates.length > 0 && (
        <section className="form-gallery" aria-label="Start a new form">
          <h2 className="small muted">Start a new form</h2>
          <ul>
            <li><button type="button" className="form-tpl blank" onClick={() => create()}><span className="form-tpl-mark" aria-hidden="true">＋</span><strong>Blank form</strong><span className="muted small">Your own questions</span></button></li>
            {templates.map((t) => (
              <li key={t.id}><button type="button" className="form-tpl" aria-label={`Start from the ${t.title} template`} onClick={() => create(t.id)}>
                <span className="form-tpl-mark" aria-hidden="true">{{ event: '📅', feedback: '⭐', rsvp: '✉️', contact: '👤', job: '💼', quiz: '❓', timeoff: '🌴', order: '🛒' }[t.id] || '📝'}</span>
                <strong>{t.title}</strong><span className="muted small">{t.blurb}</span>
              </button></li>
            ))}
          </ul>
        </section>
      )}
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
                {f.owner_name && <span className="tag">Shared by {f.owner_name}</span>}
                {f.closed && <span className="tag">{f.closed === 'full' ? 'Full' : f.closed === 'notyet' ? 'Opens later' : 'Closed'}</span>}
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
  const [prefill, setPrefill] = useState(false); // the "Get pre-filled link" window
  const [sending, setSending] = useState(false); // the Send window: by email, or the link and its QR code
  const [embedOpen, setEmbedOpen] = useState(false);
  const [responses, setResponses] = useState(null);
  const pending = useRef(null); // edits not yet saved

  useEffect(() => { get(`/forms/${id}`).then(setForm).catch((e) => setError(e.message)); }, [id]);
  const loadResponses = useCallback(() => get(`/forms/${id}/responses`).then((r) => setResponses(r.responses)).catch(() => {}), [id]);
  useEffect(() => { loadResponses(); }, [loadResponses]);
  // A colleague changed the form: take their version unless you have changes waiting to be saved.
  const reloadForm = useCallback(() => get(`/forms/${id}`).then((f) => { if (!pending.current) setForm(f); }).catch(() => {}), [id]);
  useEffect(() => onLive((m) => {
    if (m.form_id !== id) return;
    if (m.type === 'form-response') { loadResponses(); reloadForm(); }
    if (m.type === 'form-changed') {
      if (m.deleted || m.removed) { toast(m.deleted ? 'This form was deleted' : 'You were taken off this form'); navigate('/forms'); } else reloadForm();
    }
  }), [id, loadResponses, reloadForm, toast, navigate]);
  useEffect(() => { if (form?.title) document.title = `${form.title} – Forms`; }, [form?.title]);

  // Typing saves itself shortly after; leaving the page sends what's waiting.
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
      {prefill && <PrefillModal form={form} onClose={() => setPrefill(false)} />}
      {sending && <SendForm form={form} link={linkOf(form.token)} onClose={() => setSending(false)} />}
      {embedOpen && (
        <Modal title="Embed in a website" onClose={() => setEmbedOpen(false)} footer={<button type="button" className="btn" onClick={() => setEmbedOpen(false)}>Close</button>}>
          <p className="muted small" style={{ marginTop: 0 }}>Put this form on your own web page: paste the code into the page's HTML. {form.audience === 'org' ? 'This form is for people at your company, who need to be signed in; for a page anyone visits, choose “Anyone with the link” in Settings.' : 'Answers arrive here as usual.'}</p>
          <EmbedCode url={linkOf(form.token)} height={800} />
        </Modal>
      )}
      <div className="page-head">
        <button type="button" className="icon-btn" aria-label="All forms" onClick={() => navigate('/forms')}><Icon name="back" /></button>
        <input className="form-title-input grow" aria-label="Form title" value={form.title} maxLength={200} onChange={(e) => edit({ title: e.target.value })} />
        <span className="muted small nowrap" aria-live="polite">{status}</span>
        <button type="button" className="btn primary" onClick={async () => { await flush(); setSending(true); }}><Icon name="send" size={18} /> Send</button>
        <button type="button" className="btn" onClick={copyLink}><Icon name="link" size={18} /> Copy link</button>
        <a className="btn" href={`/f/${form.token}`} target="_blank" rel="noreferrer">Preview</a>
        <Menu trigger={(p) => <button className="icon-btn" aria-label="More" {...p}><Icon name="more" /></button>} items={[
          { label: 'Get pre-filled link', icon: 'link', onClick: async () => { await flush(); setPrefill(true); } },
          { label: 'Embed in a website', icon: 'link', onClick: () => setEmbedOpen(true) },
          { label: 'Make a copy', icon: 'copy', onClick: copyForm },
          form.role === 'owner' ? { label: 'Delete form', icon: 'trash', onClick: () => setConfirm(true) }
            : { label: 'Leave this form', icon: 'logout', onClick: async () => { await flush(); await del(`/forms/${id}/editors/${user.id}`); navigate('/forms'); } },
        ]} />
      </div>
      <div className="tabs" role="tablist" style={{ alignSelf: 'flex-start' }}>
        {[['questions', 'Questions'], ['responses', `Responses (${count})`], ['settings', 'Settings']].map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'questions' && <QuestionsTab form={form} edit={edit} />}
      {tab === 'responses' && <ResponsesTab form={form} responses={responses} reload={loadResponses} setting={setting} flush={flush} />}
      {tab === 'settings' && <SettingsTab form={form} setForm={setForm} setting={setting} orgName={user.org_name} allowLinks={user.allow_links} />}
      {confirm && <ConfirmModal title="Delete this form?" message={`“${form.title}” and its ${count === 1 ? 'response' : `${count} responses`} will be deleted, and its link will stop working.`}
        onClose={() => setConfirm(false)} onConfirm={async () => { pending.current = null; await del(`/forms/${id}`); navigate('/forms'); }} />}
    </div>
  );
}

const GRADED = new Set(['short', 'choice', 'checkbox', 'dropdown']);
/** A quiz question's right answer and points. */
function AnswerKey({ q, n, onChange }) {
  if (!GRADED.has(q.type)) return <p className="muted small" style={{ margin: 0 }}>Not marked (only short answers and choices are).</p>;
  const has = q.answer !== undefined && q.answer !== '' && !(Array.isArray(q.answer) && !q.answer.length);
  const set = (answer) => onChange({ answer, points: q.points ?? 1 });
  return (
    <div className="answer-key row wrap" role="group" aria-label={`Answer key for question ${n}`}>
      <strong className="small">✓ Answer</strong>
      {q.type === 'short' ? <input aria-label={`Correct answer for question ${n}`} placeholder="Correct answer (capitals don't matter)" value={q.answer || ''} maxLength={500} onChange={(e) => set(e.target.value)} />
        : q.type === 'checkbox' ? q.options.map((o) => (
          <label key={o} className="check small"><input type="checkbox" checked={(q.answer || []).includes(o)} onChange={(e) => set(e.target.checked ? [...(q.answer || []), o] : (q.answer || []).filter((x) => x !== o))} /> {o}</label>
        )) : (
          <select aria-label={`Correct answer for question ${n}`} value={q.answer || ''} onChange={(e) => set(e.target.value)}>
            <option value="">None</option>{q.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )}
      {has && <label className="row small">Points <input type="number" min={0} max={100} aria-label={`Points for question ${n}`} value={q.points ?? 1} style={{ width: 64 }} onChange={(e) => onChange({ points: Number(e.target.value) })} /></label>}
    </div>
  );
}

/** Response validation: the rule an answer must follow (formcheck.js), and the message people see. */
function CheckEditor({ q, n, onChange }) {
  const rule = q.check;
  const kinds = CHECKS[q.type];
  const set = (patch) => onChange({ ...rule, ...patch });
  let problem = null;
  if (rule) { try { cleanCheck(q.type, rule); } catch (e) { problem = e.message; } }
  const numeric = rule && !['isnum', 'whole', 'email', 'url', 'contains', 'notcontains', 'matches', 'notmatches'].includes(rule.op);
  const texty = rule && ['contains', 'notcontains', 'matches', 'notmatches'].includes(rule.op);
  return (
    <div className="form-check stack-tight" role="group" aria-label={`Response validation for question ${n}`}>
      <label className="check small"><input type="checkbox" checked={!!rule} onChange={(e) => onChange(e.target.checked ? { kind: kinds[0], op: OPS[kinds[0]][0][0] } : undefined)} /> Response validation</label>
      {rule && (
        <div className="row wrap small">
          {kinds.length > 1 && (
            <select aria-label={`Kind of rule for question ${n}`} value={rule.kind} onChange={(e) => onChange({ kind: e.target.value, op: OPS[e.target.value][0][0], ...(rule.msg && { msg: rule.msg }) })}>
              {kinds.map((k) => <option key={k} value={k}>{KIND_NAMES[k]}</option>)}
            </select>
          )}
          <select aria-label={`Rule for question ${n}`} value={rule.op} onChange={(e) => set({ op: e.target.value })}>
            {OPS[rule.kind].map(([o, label]) => <option key={o} value={o}>{label}</option>)}
          </select>
          {numeric && <input type="number" aria-label={`Value for question ${n}`} style={{ width: 90 }} value={rule.a ?? ''} onChange={(e) => set({ a: e.target.value })} />}
          {numeric && /between/.test(rule.op) && <>and <input type="number" aria-label={`Second value for question ${n}`} style={{ width: 90 }} value={rule.b ?? ''} onChange={(e) => set({ b: e.target.value })} /></>}
          {texty && <input aria-label={`${rule.kind === 'pattern' ? 'Pattern' : 'Text'} for question ${n}`} placeholder={rule.kind === 'pattern' ? '^[A-Z]{2}[0-9]{4}$' : 'Text'} maxLength={200} value={rule.a ?? ''} onChange={(e) => set({ a: e.target.value })} />}
          <input className="grow" aria-label={`Error message for question ${n}`} placeholder="Message when it doesn't fit (optional)" maxLength={200} value={rule.msg || ''} onChange={(e) => set({ msg: e.target.value })} />
        </div>
      )}
      {problem && <p className="error small" role="alert" style={{ margin: 0 }}>{problem}. Until then the rule isn't used.</p>}
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
      {qs.map((q, i) => q.type === 'section' ? (
        <section key={q.id} className="card form-section" aria-label={`Section: ${q.title || 'Untitled section'}`}>
          <div className="row wrap">
            <span className="pill">Section</span>
            <input className="grow form-q-title" aria-label={`Section ${i + 1} title`} placeholder="Section title" value={q.title} maxLength={300} onChange={(e) => change(i, { title: e.target.value })} />
          </div>
          <input className="form-q-help" aria-label={`Description of section ${i + 1}`} placeholder="Description (optional)" value={q.help || ''} maxLength={1000} onChange={(e) => change(i, { help: e.target.value })} />
          <p className="muted small" style={{ margin: 0 }}>Starts a new page. Questions below it are on this page, up to the next section.</p>
          <label className="row small">After this section
            <select aria-label={`After section ${i + 1}`} value={q.after || ''} onChange={(e) => change(i, { after: e.target.value || undefined })}>
              <option value="">Continue to the next section</option>
              {qs.slice(i + 1).filter((x) => x.type === 'section').map((x) => <option key={x.id} value={x.id}>Go to: {x.title || 'Untitled section'}</option>)}
              <option value="submit">Submit the form</option>
            </select></label>
          <div className="row form-q-foot">
            <span className="grow" />
            <button type="button" className="icon-btn" aria-label={`Move section ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="icon-btn" aria-label={`Move section ${i + 1} down`} disabled={i === qs.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="icon-btn" aria-label={`Delete section ${i + 1}`} onClick={() => setQs(qs.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
          </div>
        </section>
      ) : (
        <section key={q.id} className="card form-q" aria-label={`Question ${i + 1}`}>
          <div className="row wrap">
            <input className="grow form-q-title" aria-label={`Question ${i + 1} title`} placeholder="Question" value={q.title} maxLength={300} onChange={(e) => change(i, { title: e.target.value })} />
            <select aria-label={`Type of question ${i + 1}`} value={q.type} onChange={(e) => setQs(qs.map((x, j) => (j === i ? retype(x, e.target.value) : x)))}>
              {TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          <input className="form-q-help" aria-label={`Help text for question ${i + 1}`} placeholder="Help text (optional)" value={q.help || ''} maxLength={1000} onChange={(e) => change(i, { help: e.target.value })} />
          <QuestionPicture q={q} n={i + 1} formId={form.id} onChange={(patch) => change(i, patch)} />
          {HAS_OPTIONS.has(q.type) && (
            <ul className="form-options">
              {q.options.map((o, k) => (
                <li key={k} className="row">
                  <span className="form-option-mark" aria-hidden="true">{q.type === 'choice' ? '○' : q.type === 'checkbox' ? '☐' : `${k + 1}.`}</span>
                  <input className="grow" aria-label={`Question ${i + 1}, option ${k + 1}`} value={o} maxLength={200} onChange={(e) => {
                    const v = e.target.value;
                    // A limit follows its option when the option is renamed.
                    const limits = q.limits && q.limits[o] !== undefined ? Object.fromEntries(Object.entries(q.limits).map(([key, n]) => [key === o ? v : key, n])) : q.limits;
                    const option_images = q.option_images?.[o] ? Object.fromEntries(Object.entries(q.option_images).map(([key, id]) => [key === o ? v : key, id])) : q.option_images; // and its picture
                    change(i, { options: q.options.map((x, m) => (m === k ? v : x)), ...(limits !== q.limits && { limits }), ...(option_images !== q.option_images && { option_images }) });
                  }} />
                  {q.limits && q.type !== 'scale' && <input type="number" className="form-limit" min={1} max={100000} placeholder="No limit" aria-label={`Places for option ${k + 1}`} title="How many people can choose it (empty: no limit)"
                    value={q.limits[o] ?? ''} onChange={(e) => { const n = Math.round(Number(e.target.value)); const next = { ...q.limits }; if (e.target.value === '' || !(n >= 1)) delete next[o]; else next[o] = n; change(i, { limits: next }); }} />}
                  {(q.type === 'choice' || q.type === 'checkbox') && <OptionPicture q={q} option={o} label={`question ${i + 1}, option ${k + 1}`} formId={form.id}
                    onChange={(id) => { const next = { ...(q.option_images || {}) }; if (id) next[o] = id; else delete next[o]; change(i, { option_images: Object.keys(next).length ? next : undefined }); }} />}
                  {q.options.length > (q.type === 'rank' ? 2 : 1) && <button type="button" className="icon-btn" aria-label={`Remove option ${k + 1}`} onClick={() => change(i, { options: q.options.filter((_, m) => m !== k) })}><Icon name="close" size={16} /></button>}
                </li>
              ))}
              {q.other && <li className="row"><span className="form-option-mark" aria-hidden="true">{q.type === 'choice' ? '○' : '☐'}</span><span className="grow muted">Other…</span>
                <button type="button" className="icon-btn" aria-label="Remove “Other”" onClick={() => change(i, { other: undefined })}><Icon name="close" size={16} /></button></li>}
              {q.options.length < (q.type === 'rank' ? MAX_RANKED : 50) && <li><button type="button" className="link-btn" onClick={() => change(i, { options: [...q.options, nextOption(q.options)] })}>Add option</button>
                {(q.type === 'choice' || q.type === 'checkbox') && !q.other && <> or <button type="button" className="link-btn" onClick={() => change(i, { other: true })}>add “Other”</button></>}</li>}
            </ul>
          )}
          {GRIDS.has(q.type) && (
            <div className="form-grid-edit">
              {[['rows', 'Rows', 'Row', 30], ['columns', 'Columns', 'Column', 20]].map(([key, head, one, max]) => (
                <ul key={key} className="form-options" aria-label={`${head} of question ${i + 1}`}>
                  <li className="small"><strong>{head}</strong></li>
                  {q[key].map((o, k) => (
                    <li key={k} className="row">
                      <span className="form-option-mark" aria-hidden="true">{key === 'rows' ? `${k + 1}.` : q.type === 'grid' ? '○' : '☐'}</span>
                      <input className="grow" aria-label={`Question ${i + 1}, ${one.toLowerCase()} ${k + 1}`} value={o} maxLength={200} onChange={(e) => change(i, { [key]: q[key].map((x, m) => (m === k ? e.target.value : x)) })} />
                      {q[key].length > 1 && <button type="button" className="icon-btn" aria-label={`Remove ${one.toLowerCase()} ${k + 1}`} onClick={() => change(i, { [key]: q[key].filter((_, m) => m !== k) })}><Icon name="close" size={16} /></button>}
                    </li>
                  ))}
                  {q[key].length < max && <li><button type="button" className="link-btn" onClick={() => { let n = q[key].length + 1; while (q[key].includes(`${one} ${n}`)) n++; change(i, { [key]: [...q[key], `${one} ${n}`] }); }}>Add {one.toLowerCase()}</button></li>}
                </ul>
              ))}
            </div>
          )}
          {q.type === 'scale' && (
            <div className="row wrap">
              <label className="row small">1 to <select aria-label={`Scale of question ${i + 1}`} value={q.max} onChange={(e) => change(i, { max: Number(e.target.value) })}><option value={5}>5</option><option value={10}>10</option></select></label>
              <input aria-label={`Label for 1, question ${i + 1}`} placeholder="Label for 1 (optional)" value={q.low || ''} maxLength={60} onChange={(e) => change(i, { low: e.target.value })} />
              <input aria-label={`Label for ${q.max}, question ${i + 1}`} placeholder={`Label for ${q.max} (optional)`} value={q.high || ''} maxLength={60} onChange={(e) => change(i, { high: e.target.value })} />
            </div>
          )}
          {(q.type === 'choice' || q.type === 'dropdown') && qs.slice(i + 1).some((x) => x.type === 'section') && (
            <details className="form-goto" open={!!q.goto && Object.keys(q.goto).length > 0}>
              <summary className="small">Go to a section depending on the answer</summary>
              <ul className="form-options">
                {q.options.map((o) => (
                  <li key={o} className="row small"><span className="grow ellipsis">{o}</span>
                    <select aria-label={`After “${o}”, go to`} value={q.goto?.[o] || ''} onChange={(e) => { const g = { ...(q.goto || {}) }; if (e.target.value) g[o] = e.target.value; else delete g[o]; change(i, { goto: Object.keys(g).length ? g : undefined }); }}>
                      <option value="">Continue to the next section</option>
                      {qs.slice(i + 1).filter((x) => x.type === 'section').map((x) => <option key={x.id} value={x.id}>Go to: {x.title || 'Untitled section'}</option>)}
                      <option value="submit">Submit the form</option>
                    </select></li>
                ))}
              </ul>
            </details>
          )}
          {q.type === 'file' && (
            <label className="row small">People can send up to <select aria-label={`Files for question ${i + 1}`} value={q.max_files || 1} onChange={(e) => change(i, { max_files: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select> file{(q.max_files || 1) === 1 ? '' : 's'}, 10 MB each. They go into a “(File uploads)” folder in {form.owner?.name ? `${form.owner.name}’s` : 'your'} Drive.</label>
          )}
          {form.quiz && <AnswerKey q={q} n={i + 1} onChange={(patch) => change(i, patch)} />}
          {CHECKS[q.type] && <CheckEditor q={q} n={i + 1} onChange={(check) => change(i, { check })} />}
          {q.type === 'rating' && (
            <div className="row wrap small">
              <label className="row">Levels <select aria-label={`Levels of question ${i + 1}`} value={q.max} onChange={(e) => change(i, { max: Number(e.target.value) })}>{[3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <label className="row">Shown as <select aria-label={`Rating icon of question ${i + 1}`} value={q.icon || 'star'} onChange={(e) => change(i, { icon: e.target.value })}><option value="star">★ Stars</option><option value="heart">♥ Hearts</option><option value="thumb">👍 Thumbs</option></select></label>
            </div>
          )}
          {(q.type === 'short' || q.type === 'paragraph' || q.type === 'date' || q.type === 'time') && <p className="muted small form-q-sample">{q.type === 'date' ? 'They pick a date' : q.type === 'time' ? 'They pick a time' : q.type === 'short' ? 'Short answer text' : 'Long answer text'}</p>}
          <div className="row form-q-foot">
            <label className="check grow"><input type="checkbox" checked={q.required} onChange={(e) => change(i, { required: e.target.checked })} /> Required</label>
            {HAS_OPTIONS.has(q.type) && <label className="check"><input type="checkbox" checked={!!q.shuffle} onChange={(e) => change(i, { shuffle: e.target.checked || undefined })} /> Shuffle option order</label>}
            {HAS_OPTIONS.has(q.type) && q.type !== 'rank' && <label className="check" title="For sign-ups: a session with 12 seats, a slot for one person. Full options can't be chosen."><input type="checkbox" checked={!!q.limits} onChange={(e) => change(i, { limits: e.target.checked ? {} : undefined })} /> Limit places per option</label>}
            <button type="button" className="icon-btn" aria-label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="icon-btn" aria-label={`Move question ${i + 1} down`} disabled={i === qs.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="icon-btn" aria-label={`Duplicate question ${i + 1}`} onClick={() => setQs([...qs.slice(0, i + 1), { ...q, id: newId() }, ...qs.slice(i + 1)])}><Icon name="copy" size={18} /></button>
            <button type="button" className="icon-btn" aria-label={`Delete question ${i + 1}`} onClick={() => setQs(qs.filter((_, j) => j !== i))}><Icon name="trash" size={18} /></button>
          </div>
        </section>
      ))}
      {qs.length < 100 && <div className="row"><button type="button" className="btn" onClick={add}><Icon name="plus" size={18} /> Add question</button>
        <button type="button" className="btn" onClick={() => setQs([...qs, { id: newId(), type: 'section', title: '' }])}>Add section</button></div>}
    </div>
  );
}

// A link that opens the form with some answers filled in already (people can still change them),
// e.g. their team in a sign-up sheet sent to one department.
function PrefillModal({ form, onClose }) {
  const toast = useToast();
  const [answers, setAnswers] = useState({});
  const param = prefillParam(answers);
  const link = `${linkOf(form.token)}${param ? `?prefill=${encodeURIComponent(param)}` : ''}`;
  const copy = async () => { try { await navigator.clipboard.writeText(link); toast('Pre-filled link copied'); } catch { toast(link); } };
  return (
    <Modal title="Get pre-filled link" onClose={onClose} wide footer={<><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={!param} onClick={copy}>Copy link</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>Answer the questions you want filled in for people, then copy the link. They can still change the answers before sending.</p>
      <div className="stack form-prefill">
        {form.questions.filter((q) => q.type !== 'section' && q.type !== 'file').map((q) => (
          <Question key={q.id} q={{ ...q, required: false, check: undefined, shuffle: false }} token={form.token} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
        ))}
      </div>
      <input className="form-prefill-link" readOnly aria-label="Pre-filled link" value={param ? link : ''} placeholder="Answer a question to make the link" onFocus={(e) => e.target.select()} />
    </Modal>
  );
}

function ResponsesTab({ form, responses, reload, setting, flush }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [view, setView] = useState('summary');
  const [at, setAt] = useState(0);
  const [clear, setClear] = useState(false);
  if (!responses) return <p className="muted">Loading…</p>;
  const [linked, setLinked] = useState(form.linked_sheet || null);
  useEffect(() => { setLinked(form.linked_sheet || null); }, [form.linked_sheet]);
  const linkSheet = async () => {
    await flush();
    try { const r = await post(`/forms/${form.id}/sheet`, { link: true }); setLinked({ id: r.id }); toast('Linked: each new response is added to the spreadsheet'); window.open(`/sheets/${r.id}`, '_blank', 'noopener'); } catch (e) { toast(e.message, 'error'); }
  };
  const unlink = async () => {
    try { await del(`/forms/${form.id}/sheet`); setLinked(null); toast('Unlinked: new responses won\'t be added to the spreadsheet (it stays in your Drive)'); } catch (e) { toast(e.message, 'error'); }
  };
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
        <a className="btn" href={`/api/forms/${form.id}/responses.xlsx`} download>Download Excel</a>
        {linked
          ? <span className="row linked-sheet"><a className="btn" href={`/sheets/${linked.id}`} target="_blank" rel="noreferrer"><Icon name="sheet" size={18} /> Linked spreadsheet</a>
            <button type="button" className="link-btn small" onClick={unlink}>Unlink</button></span>
          : <button type="button" className="btn" title="A spreadsheet in your Drive that each new response is added to as it arrives" onClick={linkSheet}><Icon name="sheet" size={18} /> Link to Sheets</button>}
        <button type="button" className="btn" title="A copy of the responses so far, in a new spreadsheet" onClick={toSheet}>Open in Sheets</button>
        {responses.length > 0 && <button type="button" className="btn" onClick={() => setClear(true)}>Delete all</button>}
      </div>
      {closedNote(form) && <p className="muted small" style={{ margin: 0 }} role="status">{closedNote(form)}</p>}
      {!responses.length ? <Empty icon="form" title="No responses yet">Share the link (<strong>Copy link</strong> at the top) and answers show up here as they come in.</Empty> : <>
        <div className="tabs" role="tablist" aria-label="Show" style={{ alignSelf: 'flex-start' }}>
          <button type="button" role="tab" aria-selected={view === 'summary'} className={view === 'summary' ? 'on' : ''} onClick={() => setView('summary')}>Summary</button>
          <button type="button" role="tab" aria-selected={view === 'one'} className={view === 'one' ? 'on' : ''} onClick={() => setView('one')}>Individual</button>
        </div>
        {form.quiz && view === 'summary' && responses[0]?.max > 0 && (
          <section className="card form-summary" aria-label="Scores">
            <h3>Scores</h3>
            <p className="muted small">Average {Math.round((responses.reduce((t, r) => t + r.score, 0) / responses.length) * 10) / 10} out of {responses[0].max}</p>
            <ul className="form-bars">
              {[...new Set(responses.map((r) => r.score))].sort((a, b) => b - a).map((sc) => {
                const n = responses.filter((r) => r.score === sc).length;
                return <li key={sc}><span className="form-bar-label">{sc} / {responses[0].max}</span><span className="form-bar"><span style={{ width: percent(n / responses.length) }} /></span><span className="small nowrap">{n} ({percent(n / responses.length)})</span></li>;
              })}
            </ul>
          </section>
        )}
        {view === 'summary' ? summarize(form.questions, responses).map((s) => (
          <section key={s.id} className="card form-summary" aria-label={`Summary: ${s.title || 'Untitled question'}`}>
            <h3>{s.title || 'Untitled question'}</h3>
            <p className="muted small">{s.answered === 1 ? '1 answer' : `${s.answered} answers`}{s.average !== undefined ? ` · average ${s.average}` : ''}</p>
            {s.grid ? (
              <div className="form-grid-wrap"><table className="form-grid form-grid-sum">
                <thead><tr><th />{(s.grid[0]?.bars || []).map((b) => <th key={b.label} scope="col">{b.label}</th>)}</tr></thead>
                <tbody>{s.grid.map((g) => <tr key={g.row}><th scope="row">{g.row}</th>{g.bars.map((b) => <td key={b.label} aria-label={`${g.row}, ${b.label}: ${b.count}`}><span className="form-grid-count" style={{ '--share': b.share }}>{b.count}</span></td>)}</tr>)}</tbody>
              </table></div>
            ) : s.bars ? (
              <ul className="form-bars">
                {s.bars.map((b) => (
                  <li key={b.label}><span className="form-bar-label">{b.label}</span>
                    <span className="form-bar"><span style={{ width: percent(b.share) }} /></span>
                    <span className="small nowrap">{b.count} ({percent(b.share)})</span></li>
                ))}
              </ul>
            ) : s.ranks ? (
              <ol className="form-rank-sum" aria-label="Average places">
                {s.ranks.map((r) => (
                  <li key={r.label}><span className="grow">{r.label}</span>
                    <span className="small nowrap">{r.average == null ? 'not ranked' : `average place ${r.average}`}{r.first ? ` · first for ${r.first}` : ''}</span></li>
                ))}
              </ol>
            ) : null}
            {s.others?.length ? (
              <details className="form-others"><summary className="small">What people typed for Other ({s.others.length})</summary>
                <ul className="form-texts">{s.others.slice(0, 100).map((t, k) => <li key={k}>{t}</li>)}</ul></details>
            ) : null}
            {s.bars || s.grid || s.ranks ? null : s.files ? (
              <ul className="form-texts">{s.files.slice(0, 100).map((f) => <li key={f.file_id}><a href={`/api/forms/${form.id}/file/${f.file_id}`} target="_blank" rel="noopener noreferrer">📎 {f.name}</a></li>)}</ul>
            ) : (
              <ul className="form-texts">{s.texts.slice(0, 100).map((t, k) => <li key={k}>{t}</li>)}{s.texts.length > 100 && <li className="muted small">and {s.texts.length - 100} more (download the CSV for all of them)</li>}</ul>
            )}
          </section>
        )) : (
          <section className="card stack" aria-label="Response">
            <div className="row">
              <button type="button" className="icon-btn" aria-label="Previous response" disabled={at === 0} onClick={() => setAt(at - 1)}>‹</button>
              <span className="grow small">{Math.min(at, responses.length - 1) + 1} of {responses.length} · {formatDate(one.created_at)}{one.updated_at ? ` · changed ${formatDate(one.updated_at)}` : ''}{one.user ? ` · ${one.user.name} (${one.user.email})` : one.email ? ` · ${one.email}` : ''}{one.max ? ` · Score ${one.score} / ${one.max}` : ''}</span>
              <button type="button" className="icon-btn" aria-label="Next response" disabled={at >= responses.length - 1} onClick={() => setAt(at + 1)}>›</button>
              <button type="button" className="icon-btn" aria-label="Delete this response" onClick={async () => { await del(`/forms/${form.id}/responses/${one.id}`); setAt(Math.max(0, at - 1)); reload(); }}><Icon name="trash" size={18} /></button>
            </div>
            {form.questions.filter((q) => q.type !== 'section').map((q) => {
              const a = one.answers[q.id];
              const mark = one.right && q.id in one.right ? (one.right[q.id] ? <span className="quiz-right" aria-label="right"> ✓</span> : <span className="quiz-wrong" aria-label="wrong"> ✗</span>) : null;
              return <div key={q.id}><strong>{q.title || 'Untitled question'}</strong>{mark}<p className={a === undefined ? 'muted' : ''} style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{a === undefined ? 'No answer' : GRIDS.has(q.type) ? q.rows.filter((row) => a[row] !== undefined).map((row) => `${row}: ${[a[row]].flat().join(', ')}`).join('\n') : q.type === 'file' && Array.isArray(a) ? a.map((f, k) => <span key={f.file_id || k}>{k > 0 && ', '}<a href={`/api/forms/${form.id}/file/${f.file_id}`} target="_blank" rel="noopener noreferrer">📎 {f.name}</a></span>) : q.type === 'rank' && Array.isArray(a) ? a.map((o, k) => `${k + 1}. ${o}`).join('\n') : Array.isArray(a) ? a.join(', ') : String(a)}</p></div>;
            })}
          </section>
        )}
      </>}
      {clear && <ConfirmModal title="Delete all responses?" message={`All ${responses.length} responses will be deleted. Download the CSV first if you want to keep them.`}
        onClose={() => setClear(false)} onConfirm={async () => { await del(`/forms/${form.id}/responses`); setAt(0); reload(); }} />}
    </div>
  );
}

const pad = (n) => String(n).padStart(2, '0');
const localInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const whenText = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Why the form isn't taking answers, in words for its owner (or null). */
function closedNote(form) {
  if (!form.accepting) return 'This form is closed: people who open the link are told it isn\'t accepting responses.';
  if (form.open_at && form.open_at > Date.now()) return `This form opens on ${whenText(form.open_at)}. Until then, people who open the link are told when it opens.`;
  if (form.close_at && form.close_at <= Date.now()) return `This form closed on ${whenText(form.close_at)}. Change or clear the closing time in Settings to open it again.`;
  if (form.max_responses && (form.responses ?? 0) >= form.max_responses) return `This form has reached its limit of ${form.max_responses} responses. Raise or clear the limit in Settings to take more.`;
  return null;
}

function Editors({ form, setForm }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [people, setPeople] = useState([]);
  useEffect(() => { if (form.role === 'owner') get('/users/directory').then(setPeople).catch(() => {}); }, [form.role]);
  const add = async (e) => {
    e.preventDefault();
    try { const editors = await post(`/forms/${form.id}/editors`, { email }); setForm((f) => ({ ...f, editors })); setEmail(''); } catch (err) { toast(err.message, 'error'); }
  };
  const remove = async (u) => {
    try { const editors = await del(`/forms/${form.id}/editors/${u.id}`); setForm((f) => ({ ...f, editors })); } catch (err) { toast(err.message, 'error'); }
  };
  const taken = new Set([form.owner.id, ...form.editors.map((u) => u.id)]);
  return (
    <section className="stack-tight" aria-label="People who can edit">
      <strong>People who can edit</strong>
      <p className="muted small" style={{ margin: 0 }}>They can change the questions and settings and see the responses. Only the owner can add people or delete the form.</p>
      <ul className="form-editors">
        <li><span className="grow">{form.owner.name} <span className="muted small">{form.owner.email}</span></span><span className="muted small">Owner</span></li>
        {form.editors.map((u) => (
          <li key={u.id}><span className="grow">{u.name} <span className="muted small">{u.email}</span></span>
            {form.role === 'owner' && <button type="button" className="icon-btn" aria-label={`Remove ${u.name}`} onClick={() => remove(u)}><Icon name="close" size={16} /></button>}</li>
        ))}
      </ul>
      {form.role === 'owner' && (
        <form className="row" onSubmit={add}>
          <input className="grow" type="email" list="form-people" required aria-label="Add an editor" placeholder="Colleague's email address" value={email} onChange={(e) => setEmail(e.target.value)} />
          <datalist id="form-people">{people.filter((p) => !taken.has(p.id)).map((p) => <option key={p.id} value={p.username}>{p.name}</option>)}</datalist>
          <button className="btn">Add</button>
        </form>
      )}
    </section>
  );
}

function SettingsTab({ form, setForm, setting, orgName, allowLinks }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const [confirmation, setConfirmation] = useState(form.confirmation);
  const [limit, setLimit] = useState(form.max_responses ? String(form.max_responses) : '');
  useEffect(() => { setLimit(form.max_responses ? String(form.max_responses) : ''); }, [form.max_responses]);
  return (
    <div className="stack form-settings">
      <Editors form={form} setForm={setForm} />
      <fieldset className="stack-tight">
        <legend>Who can fill it in</legend>
        <label className="check"><input type="radio" name="aud" checked={form.audience === 'org'} onChange={() => setting({ audience: 'org' })} /> People at {orgName} (they sign in; their name is recorded)</label>
        <label className="check"><input type="radio" name="aud" checked={form.audience === 'public'} disabled={!allowLinks && form.audience !== 'public'} onChange={() => setting({ audience: 'public' })} /> Anyone with the link (no sign-in; anonymous)</label>
        {!allowLinks && <p className="muted small">Your company has turned off links for people outside it.</p>}
      </fieldset>
      {form.audience === 'org' && <label className="check"><input type="checkbox" checked={form.one_per_person} onChange={(e) => setting({ one_per_person: e.target.checked })} /> One response per person</label>}
      {form.audience === 'public' && <label className="check"><input type="checkbox" checked={!!form.collect_email} onChange={(e) => setting({ collect_email: e.target.checked })} /> Collect email addresses (people type theirs in before the questions)</label>}
      <label className="check"><input type="checkbox" checked={!!form.send_copy} onChange={(e) => setting({ send_copy: e.target.checked })} /> Send people a copy of their answers by email{form.audience === 'public' ? ' (needs email addresses collected)' : ''}</label>
      <label className="check"><input type="checkbox" checked={!!form.allow_edit} onChange={(e) => setting({ allow_edit: e.target.checked })} /> Let people change their response after sending it (they get a private link to it)</label>
      <label className="check"><input type="checkbox" checked={form.notify} onChange={(e) => setting({ notify: e.target.checked })} /> Notify me of each new response</label>
      {form.mail && <label className="check"><input type="checkbox" checked={!!form.email_me} onChange={async (e) => {
          const on = e.target.checked;
          setForm((f) => ({ ...f, email_me: on }));
          try { await put(`/forms/${form.id}/email-me`, { on }); toast(on ? `Each new response will be emailed to ${me?.username || 'you'}` : 'No more response emails'); }
          catch (err) { setForm((f) => ({ ...f, email_me: !on })); toast(err.message, 'error'); }
        }} /> Email me each response, with the answers (just for you)</label>}
      <fieldset className="stack-tight">
        <legend>Quiz</legend>
        <label className="check"><input type="checkbox" checked={form.quiz} onChange={(e) => setting({ quiz: e.target.checked })} /> Make this a quiz (give answers points, and score each response)</label>
        {form.quiz && <label className="check"><input type="checkbox" checked={form.show_score} onChange={(e) => setting({ show_score: e.target.checked })} /> Show people their score after submitting</label>}
        {form.quiz && <p className="muted small" style={{ margin: 0 }}>Set the right answers under each question on the Questions tab. People filling it in never see them.</p>}
      </fieldset>
      <div className="row wrap form-limits">
        <label className="field"><span>Open automatically on</span>
          <input type="datetime-local" value={form.open_at ? localInput(form.open_at) : ''} onChange={(e) => setting({ open_at: e.target.value ? new Date(e.target.value).getTime() : null })} /></label>
        <label className="field"><span>Close automatically on</span>
          <input type="datetime-local" value={form.close_at ? localInput(form.close_at) : ''} onChange={(e) => setting({ close_at: e.target.value ? new Date(e.target.value).getTime() : null })} /></label>
        <label className="field"><span>Stop after this many responses</span>
          <input type="number" min={1} max={10000} placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)}
            onBlur={() => { const v = limit.trim() ? Number(limit) : null; if (v !== (form.max_responses ?? null)) setting({ max_responses: v }); }} /></label>
      </div>
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

/** A picture with a question (a chart, a product, a floor plan): added from your computer, kept in your Drive. */
function QuestionPicture({ q, n, formId, onChange }) {
  const toast = useToast();
  const input = useRef();
  const [busy, setBusy] = useState(false);
  const pick = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast('Choose a picture (PNG, JPEG, GIF or WebP)', 'error'); return; }
    setBusy(true);
    try { const up = await uploadFile(file, null); onChange({ image: up.id, image_alt: q.image_alt || file.name.replace(/\.[a-z0-9]+$/i, '') }); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <div className="form-q-picture-edit">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden aria-label={`Picture for question ${n}`} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {q.image ? <>
        <img className="form-q-picture" src={`/api/forms/${formId}/pictures/${q.image}`} alt={q.image_alt || ''} />
        <div className="row small" style={{ gap: 8 }}>
          <input className="grow" aria-label={`Picture description for question ${n}`} placeholder="Describe the picture (for screen readers)" value={q.image_alt || ''} maxLength={300} onChange={(e) => onChange({ image_alt: e.target.value })} />
          <button type="button" className="link-btn small" onClick={() => input.current?.click()}>Change</button>
          <button type="button" className="link-btn small" onClick={() => onChange({ image: undefined, image_alt: undefined })}>Remove picture</button>
        </div>
      </> : <button type="button" className="link-btn small" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Adding…' : '🖼 Add picture'}</button>}
    </div>
  );
}

/** A picture for one option: a small thumbnail with × to take it off, or 🖼 to add one. */
function OptionPicture({ q, option, label, formId, onChange }) {
  const toast = useToast();
  const input = useRef();
  const id = q.option_images?.[option];
  const pick = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast('Choose a picture (PNG, JPEG, GIF or WebP)', 'error'); return; }
    try { onChange((await uploadFile(file, null)).id); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden aria-label={`Picture for ${label}`} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {id ? <span className="form-option-thumb"><img src={`/api/forms/${formId}/pictures/${id}`} alt="" /><button type="button" className="chip-x" aria-label={`Remove picture from ${label}`} onClick={() => onChange(null)}>×</button></span>
        : <button type="button" className="icon-btn" aria-label={`Add a picture to ${label}`} title="Add a picture to this option" onClick={() => input.current?.click()}>🖼</button>}
    </>
  );
}

/**
 * Send: by email from you (with who has answered so far, and a reminder for the rest), or the link with
 * a QR code to print or show (people scan it with their phone's camera).
 */
function SendForm({ form, link, onClose }) {
  const toast = useToast();
  const [tab, setTab] = useState(form.mail ? 'email' : 'link');
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [invites, setInvites] = useState(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState('');
  useEffect(() => { get(`/forms/${form.id}/invites`).then(setInvites).catch(() => setInvites([])); }, [form.id]);
  useEffect(() => { QRCode.toDataURL(link, { margin: 1, width: 320 }).then(setQr).catch(() => {}); }, [link]);
  const done = (r, what) => {
    setInvites(r.invites);
    toast(r.failed.length ? `${what} ${r.sent}; couldn't send to ${r.failed.join(', ')}` : `${what} ${r.sent} ${r.sent === 1 ? 'person' : 'people'}`, r.failed.length ? 'error' : undefined);
  };
  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { done(await post(`/forms/${form.id}/send`, { to, message }), 'Sent to'); setTo(''); } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const remind = async () => {
    setBusy(true);
    try { done(await post(`/forms/${form.id}/remind`, {}), 'Reminded'); } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const waiting = invites?.filter((i) => !i.answered).length || 0;
  const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return (
    <Modal title="Send form" onClose={onClose} wide footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className="row" role="tablist" style={{ gap: 6, marginBottom: 10 }}>
        <button type="button" role="tab" aria-selected={tab === 'email'} className={`btn small ${tab === 'email' ? 'primary' : ''}`} onClick={() => setTab('email')}>Email</button>
        <button type="button" role="tab" aria-selected={tab === 'link'} className={`btn small ${tab === 'link' ? 'primary' : ''}`} onClick={() => setTab('link')}>Link and QR code</button>
      </div>
      {tab === 'email' && (!form.mail ? <p className="muted">This server has no email: share the link instead.</p> : <div className="stack">
        <form className="stack" onSubmit={send}>
          <label className="field"><span>To</span><textarea rows={2} value={to} onChange={(e) => setTo(e.target.value)} placeholder="kim@acme.com, team@acme.com, client@example.org" /></label>
          <label className="field"><span>Message (optional)</span><textarea rows={3} value={message} maxLength={2000} onChange={(e) => setMessage(e.target.value)} placeholder={`I've invited you to fill in "${form.title}".`} /></label>
          {form.audience === 'org' && <p className="muted small" style={{ margin: 0 }}>This form is for people at your company (they sign in to fill it in). To ask people outside, set <em>Who can fill it in</em> to anyone with the link.</p>}
          {form.audience === 'public' && !form.collect_email && <p className="muted small" style={{ margin: 0 }}>To see who of them has answered, turn on <em>Collect email addresses</em> in Settings.</p>}
          <div className="row end"><button className="btn primary" disabled={busy || !to.trim()}>{busy ? 'Sending…' : 'Send'}</button></div>
        </form>
        {invites?.length > 0 && <>
          <div className="row"><strong className="grow">Sent to {invites.length} · {invites.length - waiting} answered</strong>
            {waiting > 0 && <button type="button" className="btn small" disabled={busy} onClick={remind}>Remind {waiting} who haven't answered</button>}</div>
          <ul className="invite-list" aria-label="Sent to">
            {invites.map((i) => <li key={i.email}><span className={`pill ${i.answered ? 'ok' : 'warn'}`}>{i.answered ? 'Answered' : 'Waiting'}</span> {i.email}
              <span className="muted small"> · sent {day(i.sent_at)}{i.reminded_at ? `, reminded ${day(i.reminded_at)}` : ''}</span></li>)}
          </ul>
        </>}
      </div>)}
      {tab === 'link' && <div className="stack" style={{ alignItems: 'center' }}>
        <code style={{ wordBreak: 'break-all' }}>{link}</code>
        {qr && <img src={qr} alt={`QR code for ${link}`} width={240} height={240} />}
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn" onClick={async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast(link); } }}>Copy link</button>
          {qr && <a className="btn" href={qr} download={`${form.title || 'form'} QR code.png`}>Download QR code</a>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Print the QR code on a poster or show it on a screen: people point their phone's camera at it to open the form.</p>
      </div>}
    </Modal>
  );
}
