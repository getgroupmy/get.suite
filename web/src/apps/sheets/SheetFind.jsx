// Find and replace in a sheet (Ctrl+F to find, Ctrl+H to replace).
import { useEffect, useMemo, useRef, useState } from 'react';
import { findCells, findElsewhere, findError, replaceEntry, replaceAll } from './find.js';
import Icon from '../../components/Icon.jsx';

/**
 * cells, shown(key) and hidden describe the sheet; onGo({ key, c, r }) selects a match,
 * onHits({ keys, current }) highlights them, onWrite(updates) changes cells, onDone(text) reports.
 */
export function SheetFind({ cells, shown, hidden, initial, initialOpts, replacing, canEdit, sheets, active, onSheet, onGo, onHits, onWrite, onDone, onClose }) {
  const [term, setTerm] = useState(initial || '');
  const [replace, setReplace] = useState(initialOpts?.replace || '');
  const [matchCase, setMatchCase] = useState(!!initialOpts?.matchCase);
  const [wholeCell, setWholeCell] = useState(!!initialOpts?.wholeCell);
  const [matchDiacritics, setMatchDiacritics] = useState(!!initialOpts?.matchDiacritics); // off: cafe finds café
  const [formulas, setFormulas] = useState(!!initialOpts?.formulas);
  const [regex, setRegex] = useState(!!initialOpts?.regex); // the search is a regular expression; $1… in the replacement
  const [showReplace, setShowReplace] = useState(replacing && canEdit);
  const [current, setCurrent] = useState(0);
  const input = useRef();
  const opts = { matchCase, wholeCell, formulas, matchDiacritics, regex };
  const bad = findError(term, opts);
  // On a phone the tick boxes fold away behind "Options" (they'd take half the screen); ticked ones keep them in view.
  const [more, setMore] = useState(false);
  const ticked = [matchCase, wholeCell, matchDiacritics, formulas, regex].filter(Boolean).length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => findCells(cells, shown, term, opts, hidden), [cells, shown, term, matchCase, wholeCell, formulas, matchDiacritics, regex, hidden]);
  const at = matches.length ? Math.min(current, matches.length - 1) : 0;
  // The other sheets of the workbook that have it too: one click goes on searching there.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const elsewhere = useMemo(() => (onSheet ? findElsewhere(sheets, active, term, opts) : []), [sheets, active, term, matchCase, wholeCell, formulas, matchDiacritics, regex]);

  useEffect(() => { setShowReplace((r) => r || (replacing && canEdit)); input.current?.select(); }, [replacing, canEdit]);
  useEffect(() => { setCurrent(0); }, [term, matchCase, wholeCell, formulas, matchDiacritics, regex]);
  useEffect(() => { onHits({ keys: new Set(matches.map((m) => m.key)), current: matches[at]?.key }); }, [matches, at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onHits(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // Go to the first match as the search changes.
  useEffect(() => { if (matches[0]) onGo(matches[0]); }, [term, matchCase, wholeCell, formulas, matchDiacritics, regex]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <span className="muted small find-count" aria-live="polite">{term ? (bad || (n ? `${at + 1} of ${n}` : 'No results')) : ''}</span>
        <button type="button" className="icon-btn" aria-label="Previous match" disabled={!n} onClick={() => show(at - 1)}><Icon name="left" size={18} /></button>
        <button type="button" className="icon-btn" aria-label="Next match" disabled={!n} onClick={() => show(at + 1)}><Icon name="right" size={18} /></button>
        <button type="button" className="link-btn small find-opts-toggle" aria-expanded={more || ticked > 0} disabled={ticked > 0} onClick={() => setMore(!more)}>Options{ticked ? ` (${ticked})` : more ? ' ▴' : ' ▾'}</button>
        <span className={`find-opts ${more || ticked ? 'open' : ''}`}>
        <label className="check small"><input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case</label>
        <label className="check small"><input type="checkbox" checked={wholeCell} onChange={(e) => setWholeCell(e.target.checked)} /> Whole cell</label>
        <label className="check small"><input type="checkbox" checked={matchDiacritics} onChange={(e) => setMatchDiacritics(e.target.checked)} /> Match diacritics</label>
        <label className="check small"><input type="checkbox" checked={formulas} onChange={(e) => setFormulas(e.target.checked)} /> Search formulas</label>
        <label className="check small" title="The search is a regular expression; $1 to $9 in the replacement are its groups"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regular expression</label>
        </span>
        {canEdit && !showReplace && <button type="button" className="btn small" onClick={() => setShowReplace(true)}>Replace…</button>}
        <button type="button" className="icon-btn" aria-label="Close find" onClick={onClose}><Icon name="close" size={18} /></button>
      </div>
      {elsewhere.length > 0 && (
        <div className="row small find-elsewhere" role="group" aria-label="Also found in other sheets">
          <span className="muted">Also in:</span>
          {elsewhere.map((x) => <button key={x.index} type="button" className="link-btn small" title={`Go on searching in ${x.name}`} onClick={() => onSheet(x.index, term, { ...opts, replace })}>{x.name} ({x.count})</button>)}
        </div>
      )}
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
