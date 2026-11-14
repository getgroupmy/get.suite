import { useEffect, useState } from 'react';
import { slashSuggestions } from './slash.js';

/** The / command list for a message box: { list, keyDown(e) } (keyDown returns true when it used the key). */
export function useSlash(text, setText, box) {
  const [pick, setPick] = useState(0); // the highlighted command
  const [shut, setShut] = useState(false); // closed with Escape, until you type again
  useEffect(() => { setPick(0); setShut(false); }, [text]);
  const shown = shut ? [] : slashSuggestions(text);
  const choose = (c) => { setText(`/${c.cmd}${c.cmd === 'meet' ? '' : ' '}`); box.current?.focus(); };
  // ↑ ↓ move, Tab or Enter picks, Escape closes it. A whole "/meet" or "/status" needs nothing more: Enter runs it.
  const keyDown = (e) => {
    if (!shown.length || e.shiftKey) return false;
    const whole = shown.length === 1 && text.trim() === `/${shown[0].cmd}` && shown[0].alone;
    if (whole && e.key === 'Enter') return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length); return true; }
    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); choose(shown[Math.min(pick, shown.length - 1)]); return true; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setShut(true); return true; }
    return false;
  };
  const list = shown.length > 0 && (
    <ul className="slash-list" role="listbox" aria-label="Commands">
      {shown.map((c, i) => <li key={c.cmd} role="presentation"><button type="button" role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onClick={() => choose(c)}><strong>{c.hint}</strong> <span className="muted small">{c.what}</span></button></li>)}
    </ul>
  );
  return { list, keyDown };
}
