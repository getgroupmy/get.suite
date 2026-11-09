// The find-and-replace bar above a presentation (Ctrl+F to find, Ctrl+H to replace): text boxes, table
// cells and speaker notes on every slide. Going to a match shows its slide and chooses its box.
import { useEffect, useMemo, useRef, useState } from 'react';
import { findPattern } from '../docs/findReplace.js';
import { findInDeck, replaceInDeck, contextOf } from './slidefind.js';
import Icon from '../../components/Icon.jsx';

export function SlideFind({ deck, replacing, canEdit, onGo, onReplace, onClose }) {
  const [term, setTerm] = useState('');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [showReplace, setShowReplace] = useState(replacing && canEdit);
  const [current, setCurrent] = useState(0);
  const input = useRef();
  const { matches, error } = useMemo(() => findInDeck(deck, term, { matchCase, wholeWord, regex }), [deck, term, matchCase, wholeWord, regex]);
  const n = matches.length;
  const at = n ? Math.min(current, n - 1) : 0;
  const m = matches[at];

  useEffect(() => { setShowReplace((r) => r || (replacing && canEdit)); input.current?.select(); }, [replacing, canEdit]);
  useEffect(() => { setCurrent(0); }, [term, matchCase, wholeWord, regex]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, [role=menu]')) { e.preventDefault(); closeRef.current(); } };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const show = (i) => {
    if (!n) return;
    const k = (i + n) % n;
    setCurrent(k);
    onGo(matches[k]);
  };
  const replaceOne = () => {
    if (!m) return;
    onReplace(replaceInDeck(deck, [m], replace, regex), 1); // the next one moves into its place
  };
  const replaceAll = () => { if (n) onReplace(replaceInDeck(deck, matches, replace, regex), n); };
  const key = (e) => {
    if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); show(at + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Enter' && e.target.name === 'replace') { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceAll(); else replaceOne(); }
  };
  const bad = regex && term ? error || findPattern(term, { regex: true }).error : null;
  const where = m && (m.notes ? 'Speaker notes' : m.cell ? `Table, row ${m.cell[0] + 1}` : 'Text');
  const ctx = m && contextOf(m);
  return (
    <div className="find-bar slide-find" role="search" aria-label="Find in presentation" onKeyDown={key}>
      <div className="row">
        <input ref={input} autoFocus aria-label="Find" placeholder="Find in presentation" value={term} onChange={(e) => setTerm(e.target.value)} />
        <span className={`small find-count ${bad ? 'error' : 'muted'}`} aria-live="polite">{bad || (term ? (n ? `${at + 1} of ${n}` : 'No results') : '')}</span>
        <button type="button" className="icon-btn" aria-label="Previous match" disabled={!n} onClick={() => show(at - 1)}><Icon name="left" size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Next match" disabled={!n} onClick={() => show(at + 1)}><Icon name="right" size={18} /></button>
        <label className="check small"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
        <label className="check small"><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> Whole words</label>
        <label className="check small" title="Search with a pattern, e.g. \d{4}; replace with $1, $2… for its parts"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regular expression</label>
        {canEdit && !showReplace && <button type="button" className="btn small" onClick={() => setShowReplace(true)}>Replace…</button>}
        <button type="button" className="icon-btn" aria-label="Close find" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      {m && !bad && (
        <p className="small slide-find-where" aria-label="Current match">
          <span className="muted">Slide {m.slide + 1} · {where}:</span> {ctx.before}<mark>{ctx.match}</mark>{ctx.after}
        </p>
      )}
      {showReplace && (
        <div className="row">
          <input name="replace" aria-label="Replace with" placeholder={regex ? 'Replace with ($1, $2… for the parts)' : 'Replace with'} value={replace} onChange={(e) => setReplace(e.target.value)} />
          <button type="button" className="btn small" disabled={!n} onClick={replaceOne}>Replace</button>
          <button type="button" className="btn small" disabled={!n} onClick={replaceAll}>Replace all</button>
        </div>
      )}
    </div>
  );
}
