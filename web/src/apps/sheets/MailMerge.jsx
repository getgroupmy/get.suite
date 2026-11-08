// Mail merge (Sheets): the first row's headings become placeholders ({{First name}}); each row below
// with an email address gets its own message, filled in from that row, sent from your mailbox.
import { useMemo, useRef, useState } from 'react';
import { post } from '../../api.js';
import { Modal, useToast } from '../../components/ui.jsx';
import { colName, cellKey } from './formula.js';
import { usedArea } from './sheetprint.js';
import { fillTemplate, unknownPlaceholders } from './mailmerge.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Headings and rows of a sheet: { columns: [{ c, name }], rows: [{ r, fields }] } (values as shown). */
export function sheetTable(cells, shown) {
  const area = usedArea(Object.keys(cells));
  if (!area) return { columns: [], rows: [] };
  const columns = [];
  for (let c = area.c1; c <= area.c2; c++) {
    const name = String(shown(cellKey(c, area.r1)) ?? '').trim();
    if (name) columns.push({ c, name });
  }
  const rows = [];
  for (let r = area.r1 + 1; r <= area.r2; r++) {
    const fields = {};
    let any = false;
    for (const col of columns) { const v = String(shown(cellKey(col.c, r)) ?? ''); fields[col.name] = v; if (v.trim()) any = true; }
    if (any) rows.push({ r, fields });
  }
  return { columns, rows };
}

export function MailMergeDialog({ cells, shown, from, onClose }) {
  const toast = useToast();
  const { columns, rows } = useMemo(() => sheetTable(cells, shown), [cells, shown]);
  const guess = columns.find((c) => /e-?mail/i.test(c.name)) || columns.find((c) => rows.some((r) => EMAIL.test(r.fields[c.name].trim())));
  const [emailCol, setEmailCol] = useState(guess?.name || '');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const lastField = useRef('text');
  const subjectBox = useRef(), textBox = useRef();
  const recipients = rows.filter((r) => emailCol && r.fields[emailCol]?.trim());
  const valid = recipients.filter((r) => EMAIL.test(r.fields[emailCol].trim()));
  const unknown = unknownPlaceholders(subject, text, columns.map((c) => c.name));
  const sample = recipients[Math.min(at, recipients.length - 1)];
  const insert = (name) => {
    const tag = `{{${name}}}`;
    const box = lastField.current === 'subject' ? subjectBox.current : textBox.current;
    const [val, set] = lastField.current === 'subject' ? [subject, setSubject] : [text, setText];
    const s = box?.selectionStart ?? val.length, e = box?.selectionEnd ?? val.length;
    set(val.slice(0, s) + tag + val.slice(e));
    setTimeout(() => { box?.focus(); box?.setSelectionRange(s + tag.length, s + tag.length); });
  };
  const send = async (test) => {
    setBusy(true); setConfirming(false);
    try {
      const r = await post('/mail/merge', { from, subject, text, test, columns: columns.map((c) => c.name), rows: recipients.map((x) => ({ email: x.fields[emailCol].trim(), fields: x.fields })) });
      if (test) toast(r.sent ? 'Test sent to you (filled in from the first row)' : r.failed[0]?.error || 'The test could not be sent', r.sent ? 'info' : 'error');
      else setResult(r);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const ready = emailCol && recipients.length && (subject.trim() || text.trim()) && !unknown.length;
  if (!columns.length) {
    return <Modal title="Mail merge" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <p>Put headings in the first row (like <em>Email</em>, <em>First name</em>), and one person per row below, then try again.</p></Modal>;
  }
  if (result) {
    return (
      <Modal title="Mail merge" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
        <p role="status"><strong>{result.sent}</strong> email{result.sent === 1 ? '' : 's'} sent{result.failed.length ? `; ${result.failed.length} not sent:` : '.'}</p>
        {result.failed.length > 0 && <ul className="small">{result.failed.map((f, i) => <li key={i}>{f.email}: {f.error}</li>)}</ul>}
        <p className="muted small">Copies are in your Sent folder.</p>
      </Modal>
    );
  }
  return (
    <Modal title="Mail merge" onClose={onClose} wide footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn" disabled={!ready || busy} onClick={() => send(true)}>Send a test to me</button>
      {confirming ? <button type="button" className="btn primary" disabled={busy} onClick={() => send(false)}>Yes, send {valid.length} email{valid.length === 1 ? '' : 's'}</button>
        : <button type="button" className="btn primary" disabled={!ready || busy || !valid.length} onClick={() => setConfirming(true)}>Send to {valid.length} {valid.length === 1 ? 'person' : 'people'}…</button>}
    </>}>
      <div className="stack mail-merge">
        <p className="muted small" style={{ margin: 0 }}>Each person gets their own email from {from}, with <code>{'{{Heading}}'}</code> replaced by what's in their row.</p>
        <label className="field"><span>Send to the addresses in</span>
          <select value={emailCol} onChange={(e) => setEmailCol(e.target.value)}>
            <option value="">Choose a column</option>
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name} (column {colName(c.c)})</option>)}
          </select></label>
        <div className="row wrap small" role="group" aria-label="Insert a column">
          <span className="muted">Insert:</span>
          {columns.map((c) => <button key={c.name} type="button" className="chip-btn" onClick={() => insert(c.name)}>{c.name}</button>)}
        </div>
        <label className="field"><span>Subject</span><input ref={subjectBox} value={subject} maxLength={300} onFocus={() => { lastField.current = 'subject'; }} onChange={(e) => setSubject(e.target.value)} placeholder="Your figures for {{Month}}" /></label>
        <label className="field"><span>Message</span><textarea ref={textBox} rows={7} value={text} onFocus={() => { lastField.current = 'text'; }} onChange={(e) => setText(e.target.value)} placeholder={'Dear {{First name}},\n…'} /></label>
        {unknown.length > 0 && <p className="error small" role="alert" style={{ margin: 0 }}>No column called {unknown.map((u) => `“${u}”`).join(', ')}.</p>}
        {recipients.length > valid.length && <p className="muted small" style={{ margin: 0 }}>{recipients.length - valid.length} row{recipients.length - valid.length === 1 ? '' : 's'} without a valid address will be skipped.</p>}
        {sample && (
          <section className="merge-preview" aria-label="Preview">
            <div className="row small">
              <strong className="grow">Preview: {at + 1} of {recipients.length}</strong>
              <button type="button" className="icon-btn" aria-label="Previous person" disabled={at === 0} onClick={() => setAt(at - 1)}>‹</button>
              <button type="button" className="icon-btn" aria-label="Next person" disabled={at >= recipients.length - 1} onClick={() => setAt(at + 1)}>›</button>
            </div>
            <div className="small"><span className="muted">To:</span> {sample.fields[emailCol]}</div>
            <div className="small"><span className="muted">Subject:</span> {fillTemplate(subject, sample.fields)}</div>
            <p className="merge-body">{fillTemplate(text, sample.fields)}</p>
          </section>
        )}
      </div>
    </Modal>
  );
}
