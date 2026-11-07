import { useLayoutEffect, useRef, useState } from 'react';
import { FUNCTION_NAMES } from './formula.js';
import { HELP, formulaContext, suggest, signatureParts } from './funchelp.js';

/**
 * Suggestions while typing a formula: matching function names (arrow keys, then Tab or Enter to
 * pick one) and, inside a function's brackets, what it takes with the current argument in bold.
 * Wire `track` to the input's onSelect, call `handleKey(e)` first in its onKeyDown (true means
 * it used the key), and render `popup` next to the input.
 */
export function useFormulaAssist(draft, setDraft, active) {
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [hushed, setHushed] = useState(null); // the text when Escape closed the list
  const input = useRef(null);
  const nextCaret = useRef(null);

  const ctx = active ? formulaContext(draft, Math.min(caret, draft.length)) : {};
  const choices = hushed === draft ? [] : suggest(ctx.word, FUNCTION_NAMES);
  const at = Math.min(pick, Math.max(0, choices.length - 1));
  const sig = !choices.length && ctx.fn ? signatureParts(ctx.fn, ctx.arg) : null;

  useLayoutEffect(() => {
    if (nextCaret.current === null || !input.current) return;
    input.current.setSelectionRange(nextCaret.current, nextCaret.current);
    setCaret(nextCaret.current);
    nextCaret.current = null;
  }, [draft]);

  function accept(name, el) {
    input.current = el || input.current;
    const end = Math.min(caret, draft.length);
    const rest = draft.slice(end).replace(/^[A-Za-z0-9_.]*/, ''); // the rest of a name typed over
    const open = rest.startsWith('(') ? '' : '(';
    nextCaret.current = ctx.start + name.length + 1;
    setDraft(draft.slice(0, ctx.start) + name + open + rest);
    setPick(0);
  }

  function track(e) { input.current = e.target; setCaret(e.target.selectionStart ?? e.target.value.length); }

  function handleKey(e) {
    if (!choices.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setPick((at + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length);
      return true;
    }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); accept(choices[at], e.target); return true; }
    if (e.key === 'Escape') { e.preventDefault(); setHushed(draft); return true; }
    return false;
  }

  let popup = null;
  if (choices.length) {
    popup = (
      <ul className="formula-assist" role="listbox" aria-label="Function suggestions">
        {choices.map((n, i) => (
          <li key={n} role="option" aria-selected={i === at} className={i === at ? 'on' : ''}
            onMouseDown={(e) => { e.preventDefault(); accept(n, document.activeElement); }} onMouseEnter={() => setPick(i)}>
            <b>{n}</b><span className="muted small">{HELP[n]?.[1]}</span>
          </li>
        ))}
      </ul>
    );
  } else if (sig) {
    popup = (
      <div className="formula-assist sig" role="status" aria-label="Function help">
        <code>{sig.name}(
          {sig.parts.map((p, i) => <span key={i}>{i ? ', ' : ''}{p.current ? <b>{p.text}</b> : p.text}</span>)}
        )</code>
        <div className="muted small">{sig.about}</div>
      </div>
    );
  }
  return { track, handleKey, popup };
}
