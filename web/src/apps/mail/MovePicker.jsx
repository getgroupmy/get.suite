import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';
import { pickMatches } from './mailkeys.js';

/**
 * Keyboard picker (V: move to a folder, L: put on a label): type to narrow the list, ↑/↓ to choose,
 * Enter to pick. `items` are { key, name, hint? }.
 */
export function MovePicker({ title, items, onPick, onClose }) {
  const [typed, setTyped] = useState('');
  const [at, setAt] = useState(0);
  const shown = pickMatches(items, typed);
  const cur = Math.min(at, Math.max(0, shown.length - 1));
  return (
    <Modal title={title} onClose={onClose}>
      <input className="input" autoFocus aria-label="Find" placeholder="Type to find…" value={typed}
        onChange={(e) => { setTyped(e.target.value); setAt(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt(Math.min(cur + 1, shown.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt(Math.max(cur - 1, 0)); }
          else if (e.key === 'Enter' && shown[cur]) { e.preventDefault(); onPick(shown[cur]); }
        }} />
      <ul className="move-picker" role="listbox" aria-label={title}>
        {shown.map((it, i) => (
          <li key={it.key} role="option" aria-selected={i === cur}>
            <button type="button" className={i === cur ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => onPick(it)}>
              {it.dot && <span className="label-dot" style={{ background: it.dot }} />}<span className="grow ellipsis">{it.name}</span>{it.hint && <span className="muted small">{it.hint}</span>}
            </button>
          </li>
        ))}
        {!shown.length && <li className="muted small">Nothing matches “{typed}”</li>}
      </ul>
    </Modal>
  );
}
