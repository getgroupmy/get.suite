// The Word count window (⋮ menu or Ctrl+Shift+C), and the small counter shown while typing.
import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { countDoc, counterText, readingTime, goalProgress } from './wordcount.js';

const KEY = 'nw-doc-wordcount';
/** Whether the counter shows while typing (remembered in this browser). */
export const counterOn = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const remember = (on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private window */ } };

/** The counts for the editor now: { all, part } (part only when text is selected). */
function countsOf(editor) {
  const { doc, selection } = editor.state;
  const all = countDoc(doc);
  return { all, part: selection.empty ? null : countDoc(doc, selection.from, selection.to) };
}

/** Counts that follow the editor (worked out a moment after typing stops, so long documents stay quick). */
function useCounts(editor) {
  const [c, setC] = useState(() => countsOf(editor));
  useEffect(() => {
    let t = null;
    const later = () => { clearTimeout(t); t = setTimeout(() => setC(countsOf(editor)), 150); };
    editor.on('update', later);
    editor.on('selectionUpdate', later);
    return () => { clearTimeout(t); editor.off('update', later); editor.off('selectionUpdate', later); };
  }, [editor]);
  return c;
}

export function WordCountDialog({ editor, live, onLive, onClose, goal = null, onGoal = null }) {
  const { all, part } = useCounts(editor);
  const [g, setG] = useState(goal ? String(goal) : '');
  const n = (x) => x.toLocaleString('en-GB');
  const rows = [
    ['Words', (c) => n(c.words)],
    ['Characters', (c) => n(c.characters)],
    ['Characters excluding spaces', (c) => n(c.noSpaces)],
    ['Paragraphs', (c) => n(c.paragraphs)],
    ['Reading time', (c) => (c.words ? readingTime(c.words) : '—')],
  ];
  return (
    <Modal title="Word count" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>OK</button>}>
      <table className="word-count">
        {part && <thead><tr><th /><th scope="col">Selection</th><th scope="col">Document</th></tr></thead>}
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}><th scope="row">{label}</th>{part && <td>{f(part)}</td>}<td>{f(all)}</td></tr>
          ))}
        </tbody>
      </table>
      <label className="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={live} onChange={(e) => { remember(e.target.checked); onLive(e.target.checked); }} /> Display word count while typing
      </label>
      {goal && <p className="small" style={{ margin: '8px 0 0' }}>Goal: {goalProgress(all.words, goal).text} ({goalProgress(all.words, goal).pct}%)</p>}
      {onGoal && (
        <form className="row wrap word-goal" style={{ gap: 8, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); const v = Number(g); onGoal(g.trim() && v >= 1 ? Math.round(v) : null); }}>
          <label className="row small">Word count goal <input type="number" min={1} max={1000000} step={1} value={g} placeholder="None" style={{ width: 110 }} onChange={(e) => setG(e.target.value)} aria-label="Word count goal" /></label>
          <button className="btn small">Set goal</button>
          {goal && <button type="button" className="link-btn small" onClick={() => { setG(''); onGoal(null); }}>Remove goal</button>}
        </form>
      )}
    </Modal>
  );
}

/** "340 words" in the corner of the page (or "12 of 340 words"); click it for the full counts. */
export function WordCounter({ editor, onOpen, goal = null }) {
  const { all, part } = useCounts(editor);
  const p = goal && !part ? goalProgress(all.words, goal) : null;
  return (
    <button type="button" className={`word-counter ${p?.done ? 'goal-done' : ''}`} onClick={onOpen} title="Word count (Ctrl+Shift+C)" aria-live="polite">
      {p ? p.text : counterText(all, part)}
      {p && <span className="goal-bar" aria-hidden="true"><span style={{ width: `${p.pct}%` }} /></span>}
    </button>
  );
}
