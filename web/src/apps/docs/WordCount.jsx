// The Word count window (⋮ menu or Ctrl+Shift+C), and the small counter shown while typing.
import { useEffect, useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { countDoc, counterText, readingTime } from './wordcount.js';

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

export function WordCountDialog({ editor, live, onLive, onClose }) {
  const { all, part } = useCounts(editor);
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
    </Modal>
  );
}

/** "340 words" in the corner of the page (or "12 of 340 words"); click it for the full counts. */
export function WordCounter({ editor, onOpen }) {
  const { all, part } = useCounts(editor);
  return (
    <button type="button" className="word-counter" onClick={onOpen} title="Word count (Ctrl+Shift+C)" aria-live="polite">
      {counterText(all, part)}
    </button>
  );
}
