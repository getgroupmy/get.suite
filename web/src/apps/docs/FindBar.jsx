// The find-and-replace bar above a document (Ctrl+F to find, Ctrl+H to replace).
import { useEffect, useRef, useState } from 'react';
import { findKey } from './findReplace.js';
import Icon from '../../components/Icon.jsx';

export function FindBar({ editor, replacing, canEdit, onClose }) {
  const [term, setTerm] = useState(() => { const { from, to } = editor.state.selection; const t = editor.state.doc.textBetween(from, to, ' '); return t.length < 80 ? t : ''; });
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(replacing && canEdit);
  const [, refresh] = useState(0);
  const input = useRef();
  const state = findKey.getState(editor.state) || { matches: [], current: 0 };

  useEffect(() => { setShowReplace((r) => r || (replacing && canEdit)); input.current?.select(); }, [replacing, canEdit]);
  // Keep the highlights in step with what's typed here (and with the document as others edit it).
  useEffect(() => { editor.view.dispatch(editor.state.tr.setMeta(findKey, { term, options: { matchCase, wholeWord }, current: 0 })); }, [editor, term, matchCase, wholeWord]);
  useEffect(() => {
    const f = () => refresh((n) => n + 1);
    editor.on('transaction', f);
    return () => { editor.off('transaction', f); editor.view.dispatch(editor.state.tr.setMeta(findKey, { term: '' })); };
  }, [editor]);

  // Escape closes it from anywhere (focus may be in the document, or nowhere after a button went grey).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, [role=menu]')) { e.preventDefault(); closeRef.current(); } };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const show = (i) => {
    const { matches } = findKey.getState(editor.state);
    if (!matches.length) return;
    const n = (i + matches.length) % matches.length;
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { current: n }));
    requestAnimationFrame(() => editor.view.dom.querySelector('.find-match.current')?.scrollIntoView({ block: 'center' }));
  };
  // Each replace is its own step for Undo, not merged with typing or another replace just before it.
  const ownStep = () => editor.state.plugins.find((p) => p.key.startsWith('y-undo$'))?.getState(editor.state)?.undoManager?.stopCapturing();
  const replaceOne = () => {
    const { matches, current } = findKey.getState(editor.state);
    const m = matches[current];
    if (!m) return;
    ownStep();
    const { tr, doc } = editor.state;
    if (replace) tr.replaceWith(m.from, m.to, editor.schema.text(replace, doc.resolve(m.from).marksAcross(doc.resolve(m.to)) || [])); // keeps its formatting
    else tr.delete(m.from, m.to);
    editor.view.dispatch(tr);
    show(current); // the next one moves into its place
  };
  const replaceAll = () => {
    const { matches } = findKey.getState(editor.state);
    if (!matches.length) return;
    // One change, from the end so earlier positions stay right; undone in one step.
    ownStep();
    const tr = editor.state.tr;
    for (const m of [...matches].reverse()) {
      if (replace) tr.replaceWith(m.from, m.to, editor.schema.text(replace, editor.state.doc.resolve(m.from).marksAcross(editor.state.doc.resolve(m.to)) || []));
      else tr.delete(m.from, m.to);
    }
    editor.view.dispatch(tr);
    ownStep();
  };
  const key = (e) => {
    if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); show(state.current + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Enter' && e.target.name === 'replace') { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceAll(); else replaceOne(); }
  };
  const n = state.matches.length;
  return (
    <div className="find-bar" role="search" aria-label="Find in document" onKeyDown={key}>
      <div className="row">
        <input ref={input} autoFocus aria-label="Find" placeholder="Find in document" value={term} onChange={(e) => setTerm(e.target.value)} />
        <span className="muted small find-count" aria-live="polite">{term ? (n ? `${state.current + 1} of ${n}` : 'No results') : ''}</span>
        <button type="button" className="icon-btn" aria-label="Previous match" disabled={!n} onClick={() => show(state.current - 1)}><Icon name="left" size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Next match" disabled={!n} onClick={() => show(state.current + 1)}><Icon name="right" size={18} /></button>
        <label className="check small"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
        <label className="check small"><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Whole words</label>
        {canEdit && !showReplace && <button type="button" className="btn small" onClick={() => setShowReplace(true)}>Replace…</button>}
        <button type="button" className="icon-btn" aria-label="Close find" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      {showReplace && (
        <div className="row">
          <input name="replace" aria-label="Replace with" placeholder="Replace with" value={replace} onChange={(e) => setReplace(e.target.value)} />
          <button type="button" className="btn small" disabled={!n} onClick={replaceOne}>Replace</button>
          <button type="button" className="btn small" disabled={!n} onClick={replaceAll}>Replace all</button>
        </div>
      )}
    </div>
  );
}
