// Signatures: sending a document out for signing, the banner on it while it's out (and once it's
// signed), and the signing page each signer opens from their private link (no account needed).
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { get, post, onLive } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import AddressInput from '../../components/AddressInput.jsx';
import { DocPreview } from './DocEditor.jsx';

const PdfPages = lazy(() => import('../drive/PdfPages.jsx')); // pdf.js only for PDFs
const PdfBoxesDialog = lazy(() => import('../drive/PdfBoxes.jsx'));

const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const api = async (method, url, body) => {
  const r = await fetch(`/api${url}`, { method, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
};

/** Send the document for signature: who signs, and a message. */
export function SendForSignature({ file, onClose }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [inOrder, setInOrder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState([]); // a PDF's boxes: where each signer signs
  const [placing, setPlacing] = useState(false);
  const isPdf = file.kind === 'file' && /\.pdf$/i.test(file.name || '');
  const emails = to.split(/[,;\s]+/).map((x) => x.replace(/^.*<|>$/g, '').trim().toLowerCase()).filter((x) => x.includes('@'));
  const usable = fields.filter((f) => emails.includes(f.email));
  const send = async () => {
    setBusy(true);
    try { await post('/signatures', { file_id: file.id, signers: emails, message, in_order: inOrder, ...(isPdf && usable.length && { fields: usable }) }); toast(`Sent to ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to sign`); onClose(true); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title="Send for signature" onClose={() => onClose(false)} footer={<>
      <button type="button" className="btn" onClick={() => onClose(false)}>Cancel</button>
      <button type="button" className="btn primary" disabled={!emails.length || busy} onClick={send}>Send</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Each person gets a private link to read “{file.name}” and sign it (drawn or typed). The document is locked until it's signed or you cancel.</p>
        <label className="field"><span>Signers (in order)</span><AddressInput label="Signers" value={to} onChange={setTo} placeholder="Names or email addresses" /></label>
        <label className="check small"><input type="checkbox" checked={inOrder} onChange={(e) => setInOrder(e.target.checked)} /> One after another, in this order (each is asked once the one before has signed)</label>
        <label className="field"><span>Message</span><textarea rows={3} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} placeholder="Please sign by Friday" /></label>
        {isPdf && <div className="row wrap">
          <button type="button" className="btn small" disabled={!emails.length} onClick={() => setPlacing(true)}>Place where they sign…</button>
          <span className="muted small">{usable.length ? `${usable.length} box${usable.length === 1 ? '' : 'es'} placed: their signatures and dates go there (and on a page at the end)` : 'Optional: otherwise signatures go on a page at the end'}</span>
        </div>}
      </div>
      {placing && <Suspense fallback={null}><PdfBoxesDialog file={file} signers={emails} fields={usable} onClose={() => setPlacing(false)} onSave={(f) => { setFields(f); setPlacing(false); }} /></Suspense>}
    </Modal>
  );
}

/** The document's signing: who has signed, a link for you to sign, and the record once it's done. */
export function SignatureBanner({ fileId, me, onChanged }) {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [record, setRecord] = useState(false);
  const load = () => get(`/signatures/file/${fileId}`).then((r) => setS(r.current)).catch(() => {});
  useEffect(() => { load(); return onLive((m) => { if (m.type === 'signatures-changed' && m.file_id === fileId) load(); }); }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const signed = s.signers.filter((x) => x.signed_at).length;
  const mine = s.signers.find((x) => x.my_link);
  const cancel = async () => { try { await post(`/signatures/${s.id}/cancel`); toast('Cancelled; the document is unlocked'); load(); onChanged?.(); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className={`banner sign-banner row wrap ${s.status}`} role="region" aria-label="Signatures">
      <span aria-hidden="true">✍️</span>
      <span className="grow">{s.status === 'declined'
        ? <><strong>Declined</strong> by {s.declined_by}{s.decline_reason ? `: “${s.decline_reason}”` : ''} · it can be sent again</>
        : s.status === 'complete'
        ? <><strong>Signed by everyone</strong> · {when(s.completed_at)}{s.changed_since && <> · <strong className="error">changed since it was signed</strong></>}</>
        : <><strong>Out for signature</strong>{s.in_order ? ' in order' : ''} · {signed} of {s.signers.length} signed{s.requested_by ? ` · sent by ${s.requested_by.id === me?.id ? 'you' : s.requested_by.name}` : ''}</>}</span>
      {mine && <a className="btn small primary" href={mine.my_link}>Sign now</a>}
      <button type="button" className="btn small" onClick={() => setRecord(true)}>{s.status === 'complete' ? 'Signature record' : 'Details'}</button>
      {s.status === 'pending' && s.requested_by?.id === me?.id && <button type="button" className="btn small" onClick={cancel}>Cancel</button>}
      {record && <SignatureRecord s={s} onClose={() => setRecord(false)} />}
    </div>
  );
}

/** Who signed, when, from where, with their signatures, and the document's fingerprint. */
function SignatureRecord({ s, onClose }) {
  return (
    <Modal title={`Signatures: ${s.title}`} onClose={onClose} footer={<><button type="button" className="btn" onClick={() => window.print()}>Print</button><button type="button" className="btn primary" onClick={onClose}>Close</button></>}>
      <div className="stack sign-record">
        <p className="small" style={{ margin: 0 }}>Sent {when(s.created_at)}{s.requested_by ? ` by ${s.requested_by.name} (${s.requested_by.username})` : ''}{s.message ? `: “${s.message}”` : ''}</p>
        <ul className="sign-list" aria-label="Signers">
          {s.signers.map((x) => (
            <li key={x.email}>
              <div className="sign-mark">{x.signed_at ? (x.image ? <img src={x.image} alt={`Signature of ${x.name}`} /> : <span className="sign-typed">{x.name}</span>) : <span className="muted">Waiting</span>}</div>
              <div className="small"><strong>{x.name || x.email}</strong> · {x.email}{x.signed_at && <><br />Signed {when(x.signed_at)}{x.ip ? ` from ${x.ip}` : ''} · {x.image ? 'drawn' : 'typed'}</>}</div>
            </li>
          ))}
        </ul>
        <p className="muted small" style={{ margin: 0, wordBreak: 'break-all' }}>Document fingerprint (SHA-256): {s.hash}</p>
      </div>
    </Modal>
  );
}

/** A box to draw a signature in (mouse, pen or finger). `onChange(dataUrl | null)`. */
export function SignaturePad({ onChange }) {
  const ref = useRef();
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    const c = ref.current, ctx = c.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a237e';
  }, []);
  const at = (e) => { const r = ref.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = (e) => { e.preventDefault(); ref.current.setPointerCapture(e.pointerId); drawing.current = true; const ctx = ref.current.getContext('2d'); ctx.beginPath(); ctx.moveTo(...at(e)); };
  const move = (e) => { if (!drawing.current) return; const ctx = ref.current.getContext('2d'); ctx.lineTo(...at(e)); ctx.stroke(); setEmpty(false); };
  const up = () => { if (!drawing.current) return; drawing.current = false; onChange(ref.current.toDataURL('image/png')); };
  const clear = () => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); setEmpty(true); onChange(null); };
  return (
    <div className="sign-pad-wrap">
      <canvas ref={ref} className="sign-pad" aria-label="Draw your signature" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      {!empty && <button type="button" className="link-btn small" onClick={clear}>Clear</button>}
    </div>
  );
}

/** The signing page (from a private link). */
export function SignPage({ token }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('draw');
  const [image, setImage] = useState(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(null); // the reason being typed
  useEffect(() => { api('GET', `/public/sign/${token}`).then((r) => { setD(r); setName(r.me.name || ''); }).catch((e) => setError(e.message)); }, [token]);
  if (error && !d) return <div className="auth-page"><div className="auth-card"><h1>Signing</h1><p>{error}</p></div></div>;
  if (!d) return <div className="auth-page"><p className="muted">Loading…</p></div>;
  const sign = async () => {
    setBusy(true); setError('');
    try { setD(await api('POST', `/public/sign/${token}`, { name, image: mode === 'draw' ? image : null, agree })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const ready = name.trim() && agree && (mode === 'type' || image);
  const decline = async () => {
    setBusy(true); setError('');
    try { setD(await api('POST', `/public/sign/${token}/decline`, { reason: declining })); setDeclining(null); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="sign-page">
      <header className="sign-head">
        <h1>{d.title}</h1>
        <p className="muted">{d.requested_by ? `${d.requested_by} has asked you (${d.me.email}) to sign this document.` : `For ${d.me.email} to sign.`}{d.message && <><br />“{d.message}”</>}</p>
        <p className="small">{d.signers.map((x) => `${x.name || x.email}${x.signed ? ' ✓' : ''}`).join(' · ')}</p>
      </header>
      {d.content?.pdf ? <Suspense fallback={<p className="muted">Opening the PDF…</p>}><PdfPages url={`/api/public/sign/${token}/pdf`} boxes={(d.me.signed_at || d.status !== 'pending' ? [] : d.my_boxes || []).map((b, i) => ({ ...b, key: `b${i}`, label: b.type === 'date' ? 'Date (filled in when you sign)' : 'Your signature goes here', className: 'mine' }))} /></Suspense> : <DocPreview content={d.content} />}
      <section className="sign-box card stack" aria-label="Sign">
        {d.me.signed_at ? (
          <p role="status"><strong>You signed this</strong> as {d.me.name} on {when(d.me.signed_at)}.{d.status === 'complete' ? ' Everyone has signed.' : ' The others are still to sign.'}</p>
        ) : d.status === 'declined' ? (
          <p role="status"><strong>Declined</strong> by {d.declined_by}{d.decline_reason ? `: “${d.decline_reason}”` : ''}. It is no longer waiting for signatures.</p>
        ) : d.status !== 'pending' ? <p>This is no longer waiting for signatures.</p> : declining !== null ? <>
          <h2 style={{ margin: 0 }}>Decline to sign</h2>
          <label className="field"><span>Why? (optional, {d.requested_by || 'the sender'} sees it)</span><textarea rows={3} maxLength={500} value={declining} onChange={(e) => setDeclining(e.target.value)} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row"><button type="button" className="btn danger" disabled={busy} onClick={decline}>Decline</button><button type="button" className="btn" onClick={() => setDeclining(null)}>Back</button></div>
        </> : d.waiting_for ? (
          <p role="status">It's signed in order: <strong>{d.waiting_for}</strong> signs before you. You'll be asked when it's your turn.</p>
        ) : <>
          <h2 style={{ margin: 0 }}>Sign</h2>
          <label className="field"><span>Your full name</span><input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          <div className="tabs" role="tablist" aria-label="How to sign">
            <button type="button" role="tab" aria-selected={mode === 'draw'} className={mode === 'draw' ? 'on' : ''} onClick={() => setMode('draw')}>Draw</button>
            <button type="button" role="tab" aria-selected={mode === 'type'} className={mode === 'type' ? 'on' : ''} onClick={() => setMode('type')}>Type</button>
          </div>
          {mode === 'draw' ? <SignaturePad onChange={setImage} /> : <div className="sign-typed big" aria-label="Your typed signature">{name || ' '}</div>}
          <label className="check small"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to sign this document electronically, and that this is my signature.</label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row"><button type="button" className="btn primary" disabled={!ready || busy} onClick={sign}>{busy ? 'Signing…' : 'Sign'}</button>
            <span className="grow" /><button type="button" className="link-btn small" onClick={() => setDeclining('')}>Decline to sign…</button></div>
          <p className="muted small" style={{ margin: 0 }}>The time, your address and this exact text (fingerprint {d.hash.slice(0, 12)}…) are recorded with your signature.</p>
        </>}
      </section>
    </div>
  );
}

/** Drive → Signatures: documents waiting for your signature, and the ones you've sent. */
export function SignaturesView() {
  const toast = useToast();
  const [d, setD] = useState(null);
  const load = () => get('/signatures').then(setD).catch(() => setD({ waiting: [], sent: [] }));
  useEffect(() => { load(); return onLive((m) => { if (m.type === 'signatures-changed' || m.type === 'live-connected') load(); }); }, []);
  if (!d) return <p className="muted">Loading…</p>;
  const remind = async (s) => { try { const r = await post(`/signatures/${s.id}/remind`); toast(r.reminded ? `Reminded ${r.reminded} ${r.reminded === 1 ? 'person' : 'people'}` : 'Nobody else to remind'); } catch (e) { toast(e.message, 'error'); } };
  return (
    <div className="stack">
      <section aria-label="Waiting for your signature">
        <h2 className="small">Waiting for your signature</h2>
        {!d.waiting.length ? <p className="muted small">Nothing to sign.</p> : (
          <ul className="approval-list">{d.waiting.map((s) => (
            <li key={s.id} className="row"><span className="grow"><strong>{s.title}</strong> <span className="muted small">from {s.requested_by?.name} · {when(s.created_at)}{s.message ? ` · “${s.message}”` : ''}</span></span>
              <a className="btn small primary" href={s.link}>Sign</a></li>
          ))}</ul>
        )}
      </section>
      <section aria-label="Sent for signature">
        <h2 className="small">Sent for signature</h2>
        {!d.sent.length ? <p className="muted small">Documents and PDFs you send for signature (⋮ → Send for signature… in a document, or on a PDF in Drive) are listed here.</p> : (
          <ul className="approval-list">{d.sent.map((s) => {
            const n = s.signers.filter((x) => x.signed_at).length;
            return (
              <li key={s.id} className="row"><span className="grow"><a href={s.pdf ? `/api/files/${s.signed_file_id || s.file_id}/raw` : `/docs/${s.file_id}`} {...(s.pdf && { target: '_blank', rel: 'noreferrer' })}><strong>{s.pdf && s.signed_file_id ? `${s.title.replace(/\.pdf$/i, '')} (signed).pdf` : s.title}</strong></a> <span className="muted small">{s.status === 'complete' ? `signed by everyone · ${when(s.completed_at)}` : `${n} of ${s.signers.length} signed · waiting for ${s.signers.filter((x) => !x.signed_at).map((x) => x.name || x.email).join(', ')}`}</span></span>
                {s.status === 'pending' && <button type="button" className="btn small" onClick={() => remind(s)}>Remind</button>}</li>
            );
          })}</ul>
        )}
      </section>
    </div>
  );
}

/** The signatures, printed on a page of their own after a signed document (hidden on screen). */
export function SignedPrintPage({ fileId }) {
  const [s, setS] = useState(null);
  useEffect(() => {
    const load = () => get(`/signatures/file/${fileId}`).then((r) => setS(r.current)).catch(() => {});
    load();
    return onLive((m) => { if (m.type === 'signatures-changed' && m.file_id === fileId) load(); });
  }, [fileId]);
  if (!s || s.status !== 'complete' || s.changed_since) return null;
  return (
    <section className="signed-print" aria-hidden="true">
      <h1>Signatures</h1>
      {s.signers.map((x) => (
        <div key={x.email} className="signed-print-one">
          <div className="sign-mark">{x.image ? <img src={x.image} alt="" /> : <span className="sign-typed">{x.name}</span>}</div>
          <p><strong>{x.name}</strong> {x.email}<br /><small>Signed {when(x.signed_at)}{x.ip ? ` from ${x.ip}` : ''} · {x.image ? 'drawn' : 'typed'} signature</small></p>
        </div>
      ))}
      <p><small>Signed electronically in Workspace; completed {when(s.completed_at)}. Document fingerprint (SHA-256): {s.hash}</small></p>
    </section>
  );
}
