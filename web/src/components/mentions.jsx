// Typing "@" plus a few letters in a text box suggests colleagues; picking one puts "@their@address "
// in the text. Used by comments and Chat. Mentions are written as "@" followed by the email address.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get } from '../api.js';
import { Avatar } from './ui.jsx';

export const MENTION_RE = /(@[\w.+-]+@[\w.-]+\.[a-z]{2,})/gi;

let directory = null; // fetched once per page load
const people = () => (directory ||= get('/users/directory').catch(() => { directory = null; return []; }));

/**
 * The picker for a textarea (`ref`). Call `track` from onChange and `keyDown` first in onKeyDown
 * (it returns true when it handled the key); render `list` next to the textarea.
 */
export function useMentions(ref, value, onChange) {
  const [all, setAll] = useState([]);
  const [at, setAt] = useState(null); // the "@word" being typed: { start, query }
  const [pick, setPick] = useState(0);
  const caretTo = useRef(null);
  useEffect(() => { let live = true; people().then((p) => live && setAll(p)); return () => { live = false; }; }, []);
  useLayoutEffect(() => { if (caretTo.current != null && ref.current) { ref.current.setSelectionRange(caretTo.current, caretTo.current); caretTo.current = null; } }, [value, ref]);
  const matches = at ? all.filter((p) => `${p.name} ${p.username}`.toLowerCase().includes(at.query.toLowerCase())).slice(0, 6) : [];
  const track = (text, caret) => {
    const m = /(^|\s)@([\w.+-]*)$/.exec(text.slice(0, caret));
    setAt(m ? { start: caret - m[2].length - 1, query: m[2] } : null);
    setPick(0);
  };
  const choose = (p) => {
    const caret = ref.current.selectionStart;
    caretTo.current = at.start + p.username.length + 2;
    onChange(`${value.slice(0, at.start)}@${p.username} ${value.slice(caret)}`);
    setAt(null);
    ref.current.focus();
  };
  const keyDown = (e) => {
    if (!matches.length || !['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return false;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'ArrowDown') setPick((i) => (i + 1) % matches.length);
    else if (e.key === 'ArrowUp') setPick((i) => (i - 1 + matches.length) % matches.length);
    else if (e.key === 'Escape') setAt(null);
    else choose(matches[pick]);
    return true;
  };
  const list = matches.length > 0 && (
    <ul className="mention-list" role="listbox" aria-label="People to mention">
      {matches.map((p, i) => (
        <li key={p.id} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(p); }}>
          <Avatar name={p.name} size={20} userId={p.id} /> {p.name} <span className="muted small">{p.username}</span>
        </li>
      ))}
    </ul>
  );
  return { track, keyDown, list, close: () => setAt(null) };
}
