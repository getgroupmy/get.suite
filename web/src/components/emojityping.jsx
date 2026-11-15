// ":" and a word in a plain message box (Chat's message and reply boxes): matching emoji under the box, ↑ ↓ to
// choose, Enter or Tab to put one in place of what was typed, Escape to close. Shaped like useMentions.
import { useLayoutEffect, useRef, useState } from 'react';
import { emojiQuery, matchEmoji } from './emojitype.js';

export function useEmojiTyping(ref, value, onChange, custom = []) {
  const [at, setAt] = useState(null); // { start, query }
  const [pick, setPick] = useState(0);
  const caretTo = useRef(null);
  useLayoutEffect(() => { if (caretTo.current != null && ref.current) { ref.current.setSelectionRange(caretTo.current, caretTo.current); caretTo.current = null; } }, [value, ref]);
  const matches = at ? matchEmoji(at.query, 8, custom) : [];
  const track = (text, caret) => {
    const m = emojiQuery(text.slice(0, caret), caret);
    setAt(m ? { start: m.from, query: m.query } : null);
    setPick(0);
  };
  const choose = (em) => {
    const caret = ref.current.selectionStart;
    caretTo.current = at.start + em.char.length;
    onChange(`${value.slice(0, at.start)}${em.char}${value.slice(caret)}`);
    setAt(null);
    ref.current.focus();
  };
  const keyDown = (e) => {
    if (!matches.length || !['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return false;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'ArrowDown') setPick((i) => (i + 1) % matches.length);
    else if (e.key === 'ArrowUp') setPick((i) => (i - 1 + matches.length) % matches.length);
    else if (e.key === 'Escape') setAt(null);
    else choose(matches[Math.min(pick, matches.length - 1)]);
    return true;
  };
  const list = matches.length > 0 && (
    <ul className="mention-list" role="listbox" aria-label="Emoji">
      {matches.map((em, i) => (
        <li key={em.char} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(em); }}>
          {em.img ? <img src={em.img} alt="" width={20} height={20} /> : <span aria-hidden="true" style={{ width: 20, textAlign: 'center', fontSize: 18 }}>{em.char}</span>} {em.img ? `:${em.name}:` : em.name}
        </li>
      ))}
    </ul>
  );
  return { track, keyDown, list, close: () => setAt(null) };
}
