// A code or data file (.json, .xml, .yaml, .py, .sql…) shown as its text, with line numbers; JSON written on one line
// is laid out to be read; Find in this file marks each match (Enter / Shift+Enter or the arrows step through them),
// Wrap lines keeps long lines in view, and Copy all puts the text (as shown) on the clipboard, unless the owner turned
// copying off (canCopy). Edit (onSave, for those who may change the file) edits the text as written; Save keeps the
// file as it was as an earlier version. `load` gives { text, truncated } (the first 512 KB). Shown as text: nothing in it runs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { findInLines, piecesOf } from './codefind.js';

export const TEXT_MAX = 512 * 1024;
/** Read a file's text from an address (an attachment, a chat file), the first 512 KB of it. */
export async function textFrom(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('The file couldn’t be read');
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.slice(0, TEXT_MAX).includes(0)) throw new Error('This file isn’t text');
  return { text: new TextDecoder().decode(buf.slice(0, TEXT_MAX)).replace(/�$/, ''), truncated: buf.length > TEXT_MAX };
}

/** One-line JSON laid out with indents; anything else as it is. */
export function readable(name, text) {
  if (!/\.json$/i.test(name) || text.includes('\n') || text.length > 200000) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

export default function CodeContents({ name, load, canCopy = true, onSave = null }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [laid, setLaid] = useState(true);
  const [find, setFind] = useState('');
  const [at, setAt] = useState(0);
  const [wrap, setWrap] = useState(false);
  const view = useRef(null);
  const [copied, setCopied] = useState('');
  const [draft, setDraft] = useState(null); // the text being edited (onSave: those who may edit it)
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    setD(null); setError('');
    load().then((x) => live && setD(x)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [name, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const pretty = d ? readable(name, d.text) : '';
  const text = d ? (laid ? pretty : d.text) : '';
  const lines = useMemo(() => { const l = text.split('\n'); if (l.length > 1 && l[l.length - 1] === '') l.pop(); return l; }, [text]);
  const matches = useMemo(() => findInLines(lines, find), [lines, find]);
  const current = matches.length ? Math.min(at, matches.length - 1) : -1;
  // The current match scrolled into view (within the text box, not the page).
  useEffect(() => {
    const el = view.current?.querySelector('mark.current');
    if (!el || !view.current) return;
    const box = view.current.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) view.current.scrollTop += r.top - box.top - box.height / 3;
    if (r.left < box.left || r.right > box.right) view.current.scrollLeft += r.left - box.left - box.width / 3;
  }, [current, find, wrap]);
  if (error) return <p className="muted" role="alert">{error}</p>;
  if (!d) return <p className="muted">Reading the file…</p>;
  const save = async () => {
    setSaving(true); setSaveError('');
    try { await onSave(draft, d.version); setDraft(null); setReload((r) => r + 1); } catch (e) { setSaveError(e.message); }
    setSaving(false);
  };
  if (draft !== null) return (
    <div className="code-contents stack-tight">
      <div className="row wrap">
        <span className="muted small grow">Editing: saving keeps what was there as an earlier version</span>
        <button type="button" className="btn small" disabled={saving} onClick={() => { setDraft(null); setSaveError(''); }}>Cancel</button>
        <button type="button" className="btn small primary" disabled={saving || draft === d.text} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
      {saveError && <p className="error small" role="alert">{saveError}</p>}
      <textarea className="code-edit" aria-label={`Edit ${name}`} spellCheck={false} value={draft} autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (draft !== d.text && !saving) save(); }
          if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const t = e.target, a = t.selectionStart; setDraft(draft.slice(0, a) + '\t' + draft.slice(t.selectionEnd)); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 1; }); }
        }} />
    </div>
  );
  const step = (dir) => matches.length && setAt((current + dir + matches.length) % matches.length);
  const byLine = new Map();
  matches.forEach((m, k) => { if (!byLine.has(m.line)) byLine.set(m.line, { first: k, list: [] }); byLine.get(m.line).list.push(m); });
  return (
    <div className="code-contents stack-tight">
      <div className="row wrap">
        <span className="muted small grow">{lines.length.toLocaleString()} line{lines.length === 1 ? '' : 's'}{d.truncated ? ' · only the start is shown: download it for the rest' : ''}</span>
        {pretty !== d.text && <button type="button" className="btn small" aria-pressed={laid} onClick={() => setLaid(!laid)}>{laid ? 'Show as written' : 'Lay out'}</button>}
        <button type="button" className="btn small" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>Wrap lines</button>
        {onSave && !d.truncated && <button type="button" className="btn small" onClick={() => setDraft(d.text)}>Edit</button>}
        {canCopy && <button type="button" className="btn small" onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied('Copied'); } catch { setCopied('Couldn’t copy: select the text and copy it instead'); }
          setTimeout(() => setCopied(''), 2500);
        }}>Copy all</button>}
        {copied && <span className="muted small" role="status">{copied}</span>}
      </div>
      <div className="row wrap code-find" role="search">
        <input type="search" className="grow" placeholder="Find in this file" aria-label="Find in this file" value={find}
          onChange={(e) => { setFind(e.target.value); setAt(0); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }} />
        {find && <span className="muted small" aria-live="polite">{matches.length ? `${current + 1} of ${matches.length.toLocaleString()}` : 'Not found'}</span>}
        {matches.length > 1 && <>
          <button type="button" className="icon-btn" aria-label="Previous match" onClick={() => step(-1)}>↑</button>
          <button type="button" className="icon-btn" aria-label="Next match" onClick={() => step(1)}>↓</button>
        </>}
      </div>
      <pre ref={view} className={`code-view ${wrap ? 'wrap' : ''}`} tabIndex={0} aria-label={`Text of ${name}`}>
        {lines.map((l, i) => {
          const hits = byLine.get(i);
          return (
            <span key={i} className="code-line"><span className="code-num" aria-hidden="true">{i + 1}</span>
              {hits ? piecesOf(l, hits.list, hits.first).map((p, k) => (p.hit < 0 ? p.text : <mark key={k} className={p.hit === current ? 'current' : undefined}>{p.text}</mark>)) : l}{'\n'}</span>
          );
        })}
      </pre>
    </div>
  );
}
