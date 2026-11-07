// Find and replace in a sheet (Ctrl+F to find, Ctrl+H to replace).
import { useEffect, useMemo, useRef, useState } from 'react';
import { findCells, replaceEntry, replaceAll } from './find.js';
import Icon from '../../components/Icon.jsx';

/**
 * cells, shown(key) and hidden describe the sheet; onGo({ key, c, r }) selects a match,
 * onHits({ keys, current }) highlights them, onWrite(updates) changes cells, onDone(text) reports.
 */
export function SheetFind({ cells, shown, hidden, initial, replacing, canEdit, onGo, onHits, onWrite, onDone, onClose }) {
  const [term, setTerm] = useState(initial || '');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [formulas, setFormulas] = useState(false);
  const [showReplace, setShowReplace] = useState(replacing && canEdit);
  const [current, setCurrent] = useState(0);
  const input = useRef();
  const opts = { matchCase, wholeCell, formulas };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => findCells(cells, shown, term, opts, hidden), [cells, shown, term, matchCase, wholeCell, formulas, hidden]);
  const at = matches.length ? Math.min(current, matches.length - 1) : 0;

  useEffect(() => { setShowReplace((r) => r || (replacing && canEdit)); input.current?.select(); }, [replacing, canEdit]);
  useEffect(() => { setCurrent(0); }, [term, matchCase, wholeCell, formulas]);
  useEffect(() => { onHits({ keys: new Set(matches.map((m) => m.key)), current: matches[at]?.key }); }, [matches, at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onHits(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Go to the first match as the search changes.
  useEffect(() => { if (matches[0]) onGo(matches[0]); }, [term, matchCase, wholeCell, formulas]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, [role=menu]')) { e.preventDefault(); closeRef.current(); } };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const show = (i) => {
    if (!matches.length) return;
    const n = (i + matches.length) % matches.length;
    setCurrent(n);
    onGo(matches[n]);
  };
  const replaceOne = () => {
    const m = matches[at];
    if (!m) return;
    const next = replaceEntry(cells[m.key], term, replace, opts);
    if (next === null) { onDone(`${m.key} shows this through a formula. Tick “Search formulas” to change formulas.`); show(at + 1); return; }
    onWrite({ [m.key]: next });
    // The next match takes its place (or this cell stays a match if it still matches).
    const rest = matches.filter((x) => x.key !== m.key);
    if (rest.length) { const after = rest.find((x) => x.r > m.r || (x.r === m.r && x.c > m.c)) || rest[0]; setCurrent(Math.max(0, rest.indexOf(after))); onGo(after); }
  };
  const doAll = () => {
    const { updates, count, skipped } = replaceAll(cells, matches, term, replace, opts);
    if (count) onWrite(updates);
    onDone(`Replaced in ${count} ${count === 1 ? 'cell' : 'cells'}${skipped ? `; ${skipped} formula ${skipped === 1 ? 'cell' : 'cells'} left alone` : ''}`);
  };
  const key = (e) => {
    if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); show(at + (e.shiftKey ? -1 : 1)); }
    else if (e.key === 'Enter' && e.target.name === 'replace') { e.preventDefault(); if (e.ctrlKey || e.metaKey) doAll(); else replaceOne(); }
  };
  const n = matches.length;
  return (
    <div className="find-bar" role="search" aria-label="Find in sheet" onKeyDown={key}>
      <div className="row">
        <input ref={input} autoFocus aria-label="Find" placeholder="Find in sheet" value={term} onChange={(e) => setTerm(e.target.value)} />
        <span className="muted small find-count" aria-live="polite">{term ? (n ? `${at + 1} of ${n}` : 'No results') : ''}</span>
        <button type="button" className="icon-btn" aria-label="Previous match" disabled={!n} onClick={() => show(at - 1)}><Icon name="left" size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Next match" disabled={!n} onClick={() => show(at + 1)}><Icon name="right" size={18} /></button>
        <label className="check small"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
        <label className="check small"><input type="checkbox" checked={wholeCell} onChange={(e) => setWholeCell(e.target.checked)} /> Whole cell</label>
        <label className="check small"><input type="checkbox" checked={formulas} onChange={(e) => setFormulas(e.target.checked)} /> Search formulas</label>
        {canEdit && !showReplace && <button type="button" className="btn small" onClick={() => setShowReplace(true)}>Replace…</button>}
        <button type="button" className="icon-btn" aria-label="Close find" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      {showReplace && (
        <div className="row">
          <input name="replace" aria-label="Replace with" placeholder="Replace with" value={replace} onChange={(e) => setReplace(e.target.value)} />
          <button type="button" className="btn small" disabled={!n} onClick={replaceOne}>Replace</button>
          <button type="button" className="btn small" disabled={!n} onClick={doAll}>Replace all</button>
        </div>
      )}
    </div>
  );
}
