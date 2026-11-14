// Forms: build a questionnaire, share its link, read the answers. /forms lists yours; /forms/:id edits one
// (Questions, Responses, Settings). People fill it in at /f/<token> (FormRespond.jsx).
import { REQUEST_KINDS } from '../drive/requestkinds.js';
import { printHtml } from '../mail/mailprint.js';
import { matchesFilter, filterOptions, ANSWERED, BLANK } from './formfilter.js';
import { responsesPrintHtml, blankFormHtml, summaryPrintHtml, isSignature } from './formprint.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { get, post, put, del, onLive, formatDate, uploadFile } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, Empty, Menu, Modal, useToast } from '../../components/ui.jsx';
import { Question } from './FormRespond.jsx';
import { EmbedCode } from '../editorCommon.jsx';
import SendInChat from '../../components/SendInChat.jsx';
import { useAuth } from '../../App.jsx';
import QRCode from 'qrcode';
import { TYPES, HAS_OPTIONS, GRIDS, MAX_RANKED, prefillParam, newId, retype, nextOption, summarize, percent } from './formmath.js';
import { CHECKS, OPS, KIND_NAMES, cleanCheck } from './formcheck.js';
import { FORM_COLORS, FORM_FONTS, themeStyle, withTheme } from './formtheme.js';

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
  const [find, setFind] = useState('');
  const [show, setShow] = useState('all'); // all | open | closed | shared | archived
  const shown = (forms || []).filter((f) => (show === 'archived' ? f.archived_at : !f.archived_at)
    && (show !== 'open' || !f.closed) && (show !== 'closed' || f.closed) && (show !== 'shared' || f.owner_name)
    && (!find.trim() || f.title.toLowerCase().includes(find.trim().toLowerCase())));
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
        <>
        <div className="row form-list-tools" style={{ gap: 8 }}>
          <input type="search" className="grow" aria-label="Search your forms" placeholder="Search your forms" value={find} onChange={(e) => setFind(e.target.value)} />
          <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value)}>
            <option value="all">All forms</option><option value="open">Taking responses</option><option value="closed">Closed</option>
            <option value="shared">Shared with me</option><option value="archived">Archived ({forms.filter((f) => f.archived_at).length})</option>
          </select>
        </div>
        {!shown.length && <p className="muted">{show === 'archived' ? 'Nothing archived. A form’s ⋮ → Archive puts it here.' : 'No forms match.'}</p>}
        <ul className="form-list" aria-label="Your forms">
          {shown.map((f) => (
            <li key={f.id}>
              <button type="button" className="form-row" onClick={() => navigate(`/forms/${f.id}`)}>
                <Icon name="form" />
                <span className="grow"><span className="form-row-title">{f.title}</span>
                  <span className="muted small">{f.responses === 1 ? '1 response' : `${f.responses} responses`}{f.last_response ? ` · last ${formatDate(f.last_response)}` : ''}</span></span>
                {f.owner_name && <span className="tag">Shared by {f.owner_name}</span>}
                {f.closed && <span className="tag">{f.closed === 'full' ? 'Full' : f.closed === 'notyet' ? 'Opens later' : f.closed === 'archived' ? 'Archived' : 'Closed'}</span>}
                {f.audience === 'public' && <span className="tag">Anyone with the link</span>}
                <span className="muted small nowrap">Edited {formatDate(f.updated_at)}</span>
              </button>
            </li>
          ))}
        </ul>
        </>
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
  const [theming, setTheming] = useState(false); // the Theme window
  const [importing, setImporting] = useState(false); // the Import questions window
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
    if (m.type === 'live-connected') { loadResponses(); reloadForm(); return; } // back online: what came in meanwhile
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
  // patch: the changes, or a function of the latest form giving them (for changes that finish later, such as an
  // upload, so two at once don't undo each other).
  const edit = (patch) => {
    setForm((f) => {
      const p = typeof patch === 'function' ? patch(f) : patch;
      pending.current = { ...pending.current, ...p };
      return { ...f, ...p };
    });
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
      {theming && <ThemeModal form={form} setting={setting} onClose={() => setTheming(false)} />}
      {importing && <ImportQuestions form={form} onClose={() => setImporting(false)} onDone={(f) => { setForm(f); setImporting(false); setTab('questions'); }} />}
      {sending && <SendForm form={form} link={linkOf(form.token)} setting={setting} onClose={() => setSending(false)} />}
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
        <button type="button" className="btn" onClick={() => setTheming(true)}>🎨 Theme</button>
        <a className="btn" href={`/f/${form.token}`} target="_blank" rel="noreferrer">Preview</a>
        <Menu trigger={(p) => <button className="icon-btn" aria-label="More" {...p}><Icon name="more" /></button>} items={[
          { label: 'Get pre-filled link', icon: 'link', onClick: async () => { await flush(); setPrefill(true); } },
          { label: 'Embed in a website', icon: 'link', onClick: () => setEmbedOpen(true) },
          { label: 'Import questions…', icon: 'upload', onClick: async () => { await flush(); setImporting(true); } },
          { label: 'Make a copy', icon: 'copy', onClick: copyForm },
          { label: 'Print a blank copy', icon: 'print', onClick: async () => { await flush(); printHtml(blankFormHtml(form)); } },
          form.role === 'owner' && { label: form.archived_at ? 'Bring back from the archive' : 'Archive', icon: 'archive', onClick: async () => {
            try { await flush(); const r = await put(`/forms/${id}/archived`, { archived: !form.archived_at }); setForm((x) => ({ ...x, archived_at: r.archived_at, closed: r.closed })); toast(r.archived_at ? 'Archived: out of your forms list, and it no longer takes responses' : 'Back from the archive'); } catch (e) { toast(e.message, 'error'); }
          } },
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
/** A quiz question's right answer, its points, and feedback for a right or a wrong answer. */
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
      {has && (
        <details className="answer-feedback" open={!!(q.feedback?.right || q.feedback?.wrong)}>
          <summary className="small">Answer feedback</summary>
          <p className="muted small" style={{ margin: 0 }}>Shown after submitting, with the score (when people see their score).</p>
          <label className="field"><span className="small">For a right answer</span>
            <input aria-label={`Feedback for a right answer to question ${n}`} maxLength={500} placeholder="Well done! Paris has been the capital since 987." value={q.feedback?.right || ''}
              onChange={(e) => onChange({ feedback: { ...(q.feedback || {}), right: e.target.value } })} /></label>
          <label className="field"><span className="small">For a wrong answer</span>
            <input aria-label={`Feedback for a wrong answer to question ${n}`} maxLength={500} placeholder="Have another look at chapter 2." value={q.feedback?.wrong || ''}
              onChange={(e) => onChange({ feedback: { ...(q.feedback || {}), wrong: e.target.value } })} /></label>
        </details>
      )}
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
  /** A change worked out from the question as it is when it lands (an upload that finished): question id, q → patch. */
  const changeLatest = (id, fn) => edit((f) => ({ questions: f.questions.map((q) => (q.id === id ? { ...q, ...fn(q) } : q)) }));
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
                    onChange={(id) => changeLatest(q.id, (now) => { const next = { ...(now.option_images || {}) }; if (id) next[o] = id; else delete next[o]; return { option_images: Object.keys(next).length ? next : undefined }; })} />}
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
            <div className="stack file-q-limits">
            <label className="row small">People can send up to <select aria-label={`Files for question ${i + 1}`} value={q.max_files || 1} onChange={(e) => change(i, { max_files: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select> file{(q.max_files || 1) === 1 ? '' : 's'}, up to <select aria-label={`Largest file for question ${i + 1}`} value={q.max_mb || ''} onChange={(e) => change(i, { max_mb: e.target.value ? Number(e.target.value) : undefined })}><option value="">10</option>{[1, 2, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select> MB each. They go into a “(File uploads)” folder in {form.owner?.name ? `${form.owner.name}’s` : 'your'} Drive.</label>
            <div className="row wrap small" role="group" aria-label={`Kinds of file for question ${i + 1}`}>
              <span className="muted">Only:</span>
              {REQUEST_KINDS.map(([k, kl]) => (
                <label key={k} className="check"><input type="checkbox" checked={(q.accept || []).includes(k)} onChange={(e) => { const next = e.target.checked ? [...(q.accept || []), k] : (q.accept || []).filter((x) => x !== k); change(i, { accept: next.length ? next : undefined }); }} /> {kl}</label>
              ))}
              <span className="muted">{q.accept?.length ? '' : '(none ticked: any kind)'}</span>
            </div>
            </div>
          )}
          {form.quiz && <AnswerKey q={q} n={i + 1} onChange={(patch) => change(i, patch)} />}
          {CHECKS[q.type] && <CheckEditor q={q} n={i + 1} onChange={(check) => change(i, { check })} />}
          {q.type === 'rating' && (
            <div className="row wrap small">
              <label className="row">Levels <select aria-label={`Levels of question ${i + 1}`} value={q.max} onChange={(e) => change(i, { max: Number(e.target.value) })}>{[3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <label className="row">Shown as <select aria-label={`Rating icon of question ${i + 1}`} value={q.icon || 'star'} onChange={(e) => change(i, { icon: e.target.value })}><option value="star">★ Stars</option><option value="heart">♥ Hearts</option><option value="thumb">👍 Thumbs</option></select></label>
            </div>
          )}
          {q.type === 'signature' && <p className="muted small form-q-sample">They sign in a box with a mouse, pen or finger (or type their name)</p>}
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

/** Only the responses with one answer: a question, then an option (or a number, or words they wrote). */
function ResponseFilter({ form, filter, onChange }) {
  const qs = form.questions.filter((x) => x.type !== 'section');
  const fq = filter && qs.find((x) => x.id === filter.q);
  const opts = fq && filterOptions(fq);
  const words = opts?.words && ![ANSWERED, BLANK].includes(filter.v);
  return (
    <div className="row wrap form-filter" role="group" aria-label="Filter responses">
      <label className="row" style={{ gap: 6 }}><span className="small">Show responses where</span>
        <select aria-label="Filter by question" value={fq ? fq.id : ''} onChange={(e) => { const q = qs.find((x) => x.id === e.target.value); onChange(q ? { q: q.id, v: filterOptions(q).values[0][0] } : null); }}>
          <option value="">(all responses)</option>
          {qs.map((x, i) => <option key={x.id} value={x.id}>{x.title || `Question ${i + 1}`}</option>)}
        </select></label>
      {fq && (
        <select aria-label="Answer to filter by" value={words ? '' : filter.v} onChange={(e) => onChange({ q: fq.id, v: e.target.value })}>
          {opts.values.map(([v, label]) => <option key={v || 'words'} value={v}>{label}</option>)}
        </select>
      )}
      {words && <input aria-label="Words in the answer" placeholder="Words in the answer" value={filter.v} maxLength={200} onChange={(e) => onChange({ q: fq.id, v: e.target.value })} />}
      {fq && <button type="button" className="link-btn small" onClick={() => onChange(null)}>Clear filter</button>}
    </div>
  );
}

function ResponsesTab({ form, responses: all, reload, setting, flush }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [view, setView] = useState('summary');
  const [at, setAt] = useState(0);
  const [clear, setClear] = useState(false);
  const [linked, setLinked] = useState(form.linked_sheet || null);
  useEffect(() => { setLinked(form.linked_sheet || null); }, [form.linked_sheet]);
  // Filter by one question's answer: the summary, each response, printing and downloads all follow it.
  const [filter, setFilter] = useState(null); // { q, v }
  const fq = filter && form.questions.find((x) => x.id === filter.q);
  const responses = all && (fq ? all.filter((r) => matchesFilter(form.questions, r.answers, filter)) : all);
  const query = fq ? `?fq=${encodeURIComponent(filter.q)}&fv=${encodeURIComponent(filter.v)}` : '';
  const pickFilter = (next) => { setFilter(next); setAt(0); };
  if (!responses) return <p className="muted">Loading…</p>; // (after the hooks: they run in the same order every time)
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
        <strong className="grow nowrap" role="status">{fq ? `${responses.length} of ${all.length} responses` : responses.length === 1 ? '1 response' : `${responses.length} responses`}</strong>
        <label className="check"><input type="checkbox" checked={form.accepting} onChange={(e) => setting({ accepting: e.target.checked })} /> Accepting responses</label>
        <a className="btn" href={`/api/forms/${form.id}/responses.csv${query}`} download>Download CSV</a>
        <a className="btn" href={`/api/forms/${form.id}/responses.xlsx${query}`} download>Download Excel</a>
        {responses.length > 0 && <button type="button" className="btn" title="Every response on its own page, with each question and answer" onClick={() => printHtml(responsesPrintHtml(form, responses, { when: formatDate }))}><Icon name="print" size={18} /> Print</button>}
        {responses.length > 0 && <button type="button" className="btn" title="The Summary as a report: each question's counts, bars and averages" onClick={() => printHtml(summaryPrintHtml(form, summarize(form.questions, responses), { count: responses.length }))}><Icon name="print" size={18} /> Print summary</button>}
        {linked
          ? <span className="row linked-sheet"><a className="btn" href={`/sheets/${linked.id}`} target="_blank" rel="noreferrer"><Icon name="sheet" size={18} /> Linked spreadsheet</a>
            <button type="button" className="link-btn small" onClick={unlink}>Unlink</button></span>
          : <button type="button" className="btn" title="A spreadsheet in your Drive that each new response is added to as it arrives" onClick={linkSheet}><Icon name="sheet" size={18} /> Link to Sheets</button>}
        <button type="button" className="btn" title="A copy of the responses so far, in a new spreadsheet" onClick={toSheet}>Open in Sheets</button>
        {all.length > 0 && <button type="button" className="btn" onClick={() => setClear(true)}>Delete all</button>}
      </div>
      {closedNote(form) && <p className="muted small" style={{ margin: 0 }} role="status">{closedNote(form)}</p>}
      {all.length > 1 && <ResponseFilter form={form} filter={filter} onChange={pickFilter} />}
      {!responses.length && all.length ? <Empty icon="form" title="No responses match">Try another answer, or <button type="button" className="link-btn" onClick={() => pickFilter(null)}>show all responses</button>.</Empty> : !responses.length ? <Empty icon="form" title="No responses yet">Share the link (<strong>Copy link</strong> at the top) and answers show up here as they come in.</Empty> : <>
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
            {s.bars || s.grid || s.ranks ? null : s.signatures ? (
              <ul className="form-sigs" aria-label={`Signatures for ${s.title || 'this question'}`}>{s.signatures.slice(0, 24).map((src, k) => isSignature(src) && <li key={k}><img src={src} alt={`Signature ${k + 1}`} /></li>)}{s.signatures.length > 24 && <li className="muted small">and {s.signatures.length - 24} more</li>}</ul>
            ) : s.files ? (
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
              <button type="button" className="icon-btn" aria-label="Print this response" title="Print this response (or save it as PDF)" onClick={() => printHtml(responsesPrintHtml(form, [one], { when: formatDate }).replace(/Response 1 of 1 · /, ''))}><Icon name="print" size={18} /></button>
              <button type="button" className="icon-btn" aria-label="Delete this response" onClick={async () => { await del(`/forms/${form.id}/responses/${one.id}`); setAt(Math.max(0, at - 1)); reload(); }}><Icon name="trash" size={18} /></button>
            </div>
            {form.questions.filter((q) => q.type !== 'section').map((q) => {
              const a = one.answers[q.id];
              const mark = one.right && q.id in one.right ? (one.right[q.id] ? <span className="quiz-right" aria-label="right"> ✓</span> : <span className="quiz-wrong" aria-label="wrong"> ✗</span>) : null;
              return <div key={q.id}><strong>{q.title || 'Untitled question'}</strong>{mark}<p className={a === undefined ? 'muted' : ''} style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{a === undefined ? 'No answer' : q.type === 'signature' ? (isSignature(a) ? <img className="form-sig" src={a} alt={`Signature for ${q.title || 'this question'}`} /> : 'Signed') : GRIDS.has(q.type) ? q.rows.filter((row) => a[row] !== undefined).map((row) => `${row}: ${[a[row]].flat().join(', ')}`).join('\n') : q.type === 'file' && Array.isArray(a) ? a.map((f, k) => <span key={f.file_id || k}>{k > 0 && ', '}<a href={`/api/forms/${form.id}/file/${f.file_id}`} target="_blank" rel="noopener noreferrer">📎 {f.name}</a></span>) : q.type === 'rank' && Array.isArray(a) ? a.map((o, k) => `${k + 1}. ${o}`).join('\n') : Array.isArray(a) ? a.join(', ') : String(a)}</p></div>;
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
      {form.audience === 'public' && form.collect_email && <label className="check" style={{ marginLeft: 24 }}><input type="checkbox" checked={!!form.one_per_person} onChange={(e) => setting({ one_per_person: e.target.checked })} /> One response per email address</label>}
      {form.audience === 'public' && form.collect_email && (
        <label className="field" style={{ marginLeft: 24 }}><span>Only addresses at (optional)</span>
          <input key={form.email_domains || ''} defaultValue={form.email_domains || ''} placeholder="acme.com, partner.org" maxLength={600}
            onBlur={(e) => { if (e.target.value.trim() !== (form.email_domains || '')) setting({ email_domains: e.target.value }); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </label>
      )}
      <label className="check"><input type="checkbox" checked={!!form.send_copy} onChange={(e) => setting({ send_copy: e.target.checked })} /> Send people a copy of their answers by email{form.audience === 'public' ? ' (needs email addresses collected)' : ''}</label>
      <label className="check"><input type="checkbox" checked={!!form.allow_edit} onChange={(e) => setting({ allow_edit: e.target.checked })} /> Let people change their response after sending it (they get a private link to it)</label>
      <label className="check"><input type="checkbox" checked={!!form.show_results} onChange={(e) => setting({ show_results: e.target.checked })} /> Show people who've answered what others answered (counts and charts for choices, scales and rankings; never who said what, nor anything typed)</label>
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

const TYPE_NAMES = Object.fromEntries(TYPES.map(([k, label]) => [k, label]));
/** Import questions: pick another of your forms, tick the questions to bring, and they're added at the end. */
function ImportQuestions({ form, onClose, onDone }) {
  const toast = useToast();
  const [forms, setForms] = useState(null);
  const [from, setFrom] = useState('');
  const [src, setSrc] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/forms').then((l) => setForms(l.filter((f) => f.id !== form.id && !f.archived_at))).catch((e) => toast(e.message, 'error')); }, [form.id, toast]);
  useEffect(() => {
    setSrc(null);
    if (!from) return;
    get(`/forms/${from}`).then((f) => { setSrc(f); setPicked(new Set(f.questions.map((q) => q.id))); }).catch((e) => toast(e.message, 'error'));
  }, [from, toast]);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post(`/forms/${form.id}/import`, { from, ids: [...picked] });
      toast(`${r.imported} question${r.imported === 1 ? '' : 's'} added at the end${r.pictures_left_off ? ` (${r.pictures_left_off} picture${r.pictures_left_off === 1 ? '' : 's'} left off: they belong to someone not on this form)` : ''}`);
      onDone(r);
    } catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  const all = src && picked.size === src.questions.length;
  return (
    <Modal title="Import questions" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn primary" disabled={!picked.size || !src || busy} onClick={go}>{busy ? 'Importing…' : `Import ${picked.size || ''}`.trim()}</button>
    </>}>
      <div className="stack">
        <label className="field"><span>From the form</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={!forms}>
            <option value="">{forms ? (forms.length ? 'Choose a form…' : 'You have no other forms') : 'Loading…'}</option>
            {forms?.map((f) => <option key={f.id} value={f.id}>{f.title}{f.owner_name ? ` (${f.owner_name})` : ''}</option>)}
          </select></label>
        {from && !src && <p className="muted">Loading…</p>}
        {src && (src.questions.length ? <>
          <label className="check"><input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(src.questions.map((q) => q.id)))} /> All {src.questions.length}</label>
          <ul className="form-import-list" aria-label="Questions to import">
            {src.questions.map((q) => (
              <li key={q.id}><label className="check">
                <input type="checkbox" checked={picked.has(q.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(q.id)) n.delete(q.id); else n.add(q.id); return n; })} />
                <span className="grow">{q.title || (q.type === 'section' ? 'Untitled section' : 'Untitled question')}</span>
                <span className="muted small">{q.type === 'section' ? 'Section' : TYPE_NAMES[q.type] || q.type}</span>
              </label></li>
            ))}
          </ul>
          <p className="muted small" style={{ margin: 0 }}>They're copied to the end of this form; the other form doesn't change.</p>
        </> : <p className="muted">That form has no questions.</p>)}
      </div>
    </Modal>
  );
}

/** The form's look: colour, page, font and a header picture, saved as they're picked (and shown in a small preview). */
function ThemeModal({ form, setting, onClose }) {
  const toast = useToast();
  const input = useRef();
  const [busy, setBusy] = useState(false);
  const theme = form.theme;
  const change = (patch) => setting({ theme: withTheme(theme, patch) });
  const pick = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast('Choose a picture (PNG, JPEG, GIF or WebP)', 'error'); return; }
    setBusy(true);
    try { const up = await uploadFile(file, null); await change({ header: up.id, header_alt: file.name.replace(/\.[a-z0-9]+$/i, '') }); }
    catch (e) { toast(e.message, 'error'); }
    setBusy(false);
  };
  return (
    <Modal title="Theme" onClose={onClose} footer={<>
      {theme && <button type="button" className="btn" onClick={() => setting({ theme: null })}>Reset to plain</button>}
      <button type="button" className="btn primary" onClick={onClose}>Done</button>
    </>}>
      <div className="stack">
        <div className="stack-tight">
          <span className="small" style={{ fontWeight: 600 }} id="ft-color">Colour</span>
          <div className="form-theme-colors" role="radiogroup" aria-labelledby="ft-color">
            <button type="button" role="radio" aria-checked={!theme?.color} className="form-theme-swatch none" aria-label="Default" title="Default" onClick={() => change({ color: null })}>{!theme?.color ? '✓' : ''}</button>
            {FORM_COLORS.map(([k, label, hex]) => (
              <button key={k} type="button" role="radio" aria-checked={theme?.color === k} className="form-theme-swatch" style={{ background: hex }} aria-label={label} title={label} onClick={() => change({ color: k })}>{theme?.color === k ? '✓' : ''}</button>
            ))}
          </div>
        </div>
        <fieldset className="stack-tight">
          <legend className="small" style={{ fontWeight: 600 }}>Page</legend>
          <label className="check"><input type="radio" name="ft-bg" checked={theme?.background !== 'tinted'} onChange={() => change({ background: null })} /> Plain</label>
          <label className="check"><input type="radio" name="ft-bg" checked={theme?.background === 'tinted'} onChange={() => change({ background: 'tinted' })} /> Tinted with the colour</label>
        </fieldset>
        <label className="stack-tight"><span className="small" style={{ fontWeight: 600 }}>Font</span>
          <select value={theme?.font || 'basic'} onChange={(e) => change({ font: e.target.value })}>
            {FORM_FONTS.map(([k, label, stack]) => <option key={k} value={k} style={{ fontFamily: stack }}>{label}</option>)}
          </select>
        </label>
        <div className="stack-tight">
          <span className="small" style={{ fontWeight: 600 }}>Header picture</span>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden aria-label="Header picture" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          {theme?.header ? <>
            <img className="form-theme-header-edit" src={`/api/forms/${form.id}/pictures/${theme.header}`} alt={theme.header_alt || ''} />
            <div className="row">
              <button type="button" className="link-btn small" disabled={busy} onClick={() => input.current?.click()}>Change</button>
              <button type="button" className="link-btn small" onClick={() => change({ header: null })}>Remove header picture</button>
            </div>
          </> : <div><button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Adding…' : '🖼 Add a header picture'}</button></div>}
          <span className="muted small">Shown across the top of the form; a wide picture (about 4:1) fits best.</span>
        </div>
        <div className="form-theme-preview-wrap" style={themeStyle(theme)} aria-label="Preview" role="group">
          <div className="form-theme-preview"><strong>{form.title}</strong><div className="muted small">How the top of your form looks</div>
            <button type="button" className="btn primary small" tabIndex={-1} style={{ marginTop: 8 }}>Submit</button></div>
        </div>
      </div>
    </Modal>
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
function SendForm({ form, link, setting, onClose }) {
  const toast = useToast();
  const [tab, setTab] = useState(form.mail ? 'email' : 'link');
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [invites, setInvites] = useState(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState('');
  const [chat, setChat] = useState(false);
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
  // Send in Chat: the form's link goes into a conversation's message box (Chat shows it as a form card).
  if (chat) return <SendInChat items={[{ name: form.title || 'Untitled form', url: link }]} what="the form" onClose={onClose} />;
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
          <p className="muted small" style={{ margin: 0 }}>A group's address (like <em>team@</em>) sends it to each person in the group, so you can see who of them has answered.</p>
          <div className="row end"><button className="btn primary" disabled={busy || !to.trim()}>{busy ? 'Sending…' : 'Send'}</button></div>
        </form>
        <label className="check"><input type="checkbox" checked={!!form.auto_remind} disabled={!form.close_at} onChange={(e) => setting({ auto_remind: e.target.checked })} />
          Remind those who haven't answered a day before it closes{form.close_at ? ` (${new Date(form.close_at - 864e5).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })})` : ''}</label>
        {!form.close_at && <p className="muted small" style={{ margin: 0 }}>Set <em>Close automatically on</em> in Settings to use this.</p>}
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
          <button type="button" className="btn" onClick={() => setChat(true)}>Send in Chat…</button>
          {qr && <a className="btn" href={qr} download={`${form.title || 'form'} QR code.png`}>Download QR code</a>}
        </div>
        <p className="muted small" style={{ margin: 0 }}>Print the QR code on a poster or show it on a screen: people point their phone's camera at it to open the form.</p>
      </div>}
    </Modal>
  );
}
