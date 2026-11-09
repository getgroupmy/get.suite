// Goal seek (Sheets): which number in one cell makes a formula come to the value you want.
// Solve shows the answer first; Keep it puts the number in the cell (one step for Undo).
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { goalSeek } from './goalseek.js';
import { display } from './formula.js';

export function GoalSeekDialog({ sheets, index, setCell, imports, functions, onKeep, onClose }) {
  const [set, setSet] = useState(setCell || '');
  const [goal, setGoal] = useState('');
  const [changing, setChanging] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const solve = () => {
    setBusy(true);
    // Let "Working it out…" show before the sheet is worked out again and again.
    setTimeout(() => { setFound({ ...goalSeek(sheets, index, set, goal, changing, { imports, functions }), changing: changing.trim().toUpperCase().replace(/\$/g, ''), set: set.trim().toUpperCase().replace(/\$/g, '') }); setBusy(false); }, 0);
  };
  const edit = (f) => (e) => { f(e.target.value); setFound(null); };
  const ok = found && !found.error;
  return (
    <Modal title="Goal seek" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      {ok ? <button type="button" className="btn primary" onClick={() => onKeep(found.changing, found.value)}>Keep it</button>
        : <button type="button" className="btn primary" disabled={busy} onClick={solve}>{busy ? 'Working it out…' : 'Solve'}</button>}
    </>}>
      <p className="muted small">Finds the number to put in one cell so that a formula comes to the value you want: say, the price that gives a profit of 10,000.</p>
      <form className="stack" onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.isComposing && !busy) { e.preventDefault(); if (ok) onKeep(found.changing, found.value); else solve(); } }}>
        <label className="field">Set cell<input value={set} onChange={edit(setSet)} placeholder="The formula's cell, e.g. B5" autoFocus={!setCell} /></label>
        <label className="field">To value<input value={goal} onChange={edit(setGoal)} inputMode="decimal" placeholder="e.g. 10000" autoFocus={!!setCell} /></label>
        <label className="field">By changing<input value={changing} onChange={edit(setChanging)} placeholder="A cell with a number in it, e.g. B2" /></label>
      </form>
      {found && (found.error
        ? <p className="error small" role="alert">{found.error}</p>
        : <p className="goal-found" role="status"><strong>{found.changing} = {display(found.value)}</strong> makes {found.set} come to {display(found.result)}.</p>)}
    </Modal>
  );
}
