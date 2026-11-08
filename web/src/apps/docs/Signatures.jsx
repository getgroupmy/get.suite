// Signatures: sending a document out for signing, the banner on it while it's out (and once it's
// signed), and the signing page each signer opens from their private link (no account needed).
import { useEffect, useRef, useState } from 'react';
import { get, post, onLive } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import AddressInput from '../../components/AddressInput.jsx';
import { DocPreview } from './DocEditor.jsx';

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
  const [busy, setBusy] = useState(false);
  const emails = to.split(/[,;\s]+/).map((x) => x.replace(/^.*<|>$/g, '').trim()).filter((x) => x.includes('@'));
  const send = async () => {
    setBusy(true);
    try { await post('/signatures', { file_id: file.id, signers: emails, message }); toast(`Sent to ${emails.length} ${emails.length === 1 ? 'person' : 'people'} to sign`); onClose(true); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <Modal title="Send for signature" onClose={() => onClose(false)} footer={<>
      <button type="button" className="btn" onClick={() => onClose(false)}>Cancel</button>
      <button type="button" className="btn primary" disabled={!emails.length || busy} onClick={send}>Send</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>Each person gets a private link to read “{file.name}” and sign it (drawn or typed). The document is locked until it's signed or you cancel.</p>
        <label className="field"><span>Signers (in order)</span><AddressInput label="Signers" value={to} onChange={setTo} placeholder="Names or email addresses" /></label>
        <label className="field"><span>Message</span><textarea rows={3} value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} placeholder="Please sign by Friday" /></label>
      </div>
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
      <span className="grow">{s.status === 'complete'
        ? <><strong>Signed by everyone</strong> · {when(s.completed_at)}{s.changed_since && <> · <strong className="error">changed since it was signed</strong></>}</>
        : <><strong>Out for signature</strong> · {signed} of {s.signers.length} signed{s.requested_by ? ` · sent by ${s.requested_by.id === me?.id ? 'you' : s.requested_by.name}` : ''}</>}</span>
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
function SignaturePad({ onChange }) {
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
  useEffect(() => { api('GET', `/public/sign/${token}`).then((r) => { setD(r); setName(r.me.name || ''); }).catch((e) => setError(e.message)); }, [token]);
  if (error && !d) return <div className="auth-page"><div className="auth-card"><h1>Signing</h1><p>{error}</p></div></div>;
  if (!d) return <div className="auth-page"><p className="muted">Loading…</p></div>;
  const sign = async () => {
    setBusy(true); setError('');
    try { setD(await api('POST', `/public/sign/${token}`, { name, image: mode === 'draw' ? image : null, agree })); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const ready = name.trim() && agree && (mode === 'type' || image);
  return (
    <div className="sign-page">
      <header className="sign-head">
        <h1>{d.title}</h1>
        <p className="muted">{d.requested_by ? `${d.requested_by} has asked you (${d.me.email}) to sign this document.` : `For ${d.me.email} to sign.`}{d.message && <><br />“{d.message}”</>}</p>
        <p className="small">{d.signers.map((x) => `${x.name || x.email}${x.signed ? ' ✓' : ''}`).join(' · ')}</p>
      </header>
      <DocPreview content={d.content} />
      <section className="sign-box card stack" aria-label="Sign">
        {d.me.signed_at ? (
          <p role="status"><strong>You signed this</strong> as {d.me.name} on {when(d.me.signed_at)}.{d.status === 'complete' ? ' Everyone has signed.' : ' The others are still to sign.'}</p>
        ) : d.status !== 'pending' ? <p>This is no longer waiting for signatures.</p> : <>
          <h2 style={{ margin: 0 }}>Sign</h2>
          <label className="field"><span>Your full name</span><input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          <div className="tabs" role="tablist" aria-label="How to sign">
            <button type="button" role="tab" aria-selected={mode === 'draw'} className={mode === 'draw' ? 'on' : ''} onClick={() => setMode('draw')}>Draw</button>
            <button type="button" role="tab" aria-selected={mode === 'type'} className={mode === 'type' ? 'on' : ''} onClick={() => setMode('type')}>Type</button>
          </div>
          {mode === 'draw' ? <SignaturePad onChange={setImage} /> : <div className="sign-typed big" aria-label="Your typed signature">{name || ' '}</div>}
          <label className="check small"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to sign this document electronically, and that this is my signature.</label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row"><button type="button" className="btn primary" disabled={!ready || busy} onClick={sign}>{busy ? 'Signing…' : 'Sign'}</button></div>
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
        {!d.sent.length ? <p className="muted small">Documents you send for signature (⋮ → Send for signature… in a document) are listed here.</p> : (
          <ul className="approval-list">{d.sent.map((s) => {
            const n = s.signers.filter((x) => x.signed_at).length;
            return (
              <li key={s.id} className="row"><span className="grow"><a href={`/docs/${s.file_id}`}><strong>{s.title}</strong></a> <span className="muted small">{s.status === 'complete' ? `signed by everyone · ${when(s.completed_at)}` : `${n} of ${s.signers.length} signed · waiting for ${s.signers.filter((x) => !x.signed_at).map((x) => x.name || x.email).join(', ')}`}</span></span>
                {s.status === 'pending' && <button type="button" className="btn small" onClick={() => remind(s)}>Remind</button>}</li>
            );
          })}</ul>
        )}
      </section>
    </div>
  );
}
