// A box for naming a colleague: type a name (its words in any order, accents aside) or an address and
// the people it fits are listed; a click, or ↑ ↓ and Enter, puts their address in the box.
import { useState } from 'react';
import { Avatar } from './ui.jsx';
import { colleaguesFor } from './colleagues.js';

export default function ColleagueInput({ people, value, onChange, label, placeholder = 'A colleague’s name or email address', listId, required, extra }) {
  const [at, setAt] = useState(0);
  const [shut, setShut] = useState(false); // Escape closed the list for what's typed
  const listed = shut ? [] : colleaguesFor(people, value);
  const pick = (p) => { onChange(p.username); setAt(0); };
  return (
    <span className="colleague-input grow">
      <input type="text" inputMode="email" autoComplete="off" required={required} aria-label={label} placeholder={placeholder} value={value}
        role="combobox" aria-expanded={listed.length > 0} aria-controls={listId} aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); setAt(0); setShut(false); }}
        onKeyDown={(e) => {
          if (!listed.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => (i + 1) % listed.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => (i - 1 + listed.length) % listed.length); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(listed[Math.min(at, listed.length - 1)]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setShut(true); }
        }} />
      {listed.length > 0 && (
        <ul id={listId} className="address-list" role="listbox" aria-label="Matching people">
          {listed.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
              <Avatar name={p.name} size={24} userId={p.id} />
              <span className="grow"><span>{p.name}</span> <span className="muted small">{p.username}</span></span>
              {extra?.(p)}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
