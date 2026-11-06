// An address line (To, Cc, Bcc): type part of a name or address and pick from your contacts and
// colleagues. Up/Down choose, Enter or Tab take one, Escape closes the list.
import { useEffect, useRef, useState } from 'react';
import { get } from '../api.js';
import { Avatar } from './ui.jsx';
import { currentToken, insertAddress } from './addresses.js';

export default function AddressInput({ value, onChange, label, ...rest }) {
  const ref = useRef();
  const [token, setToken] = useState(null);
  const [list, setList] = useState([]);
  const [pick, setPick] = useState(0);
  const caretTo = useRef(null);
  useEffect(() => { if (caretTo.current != null) { ref.current?.setSelectionRange(caretTo.current, caretTo.current); caretTo.current = null; } }, [value]);
  useEffect(() => {
    if (!token || token.text.length < 1 || token.text.includes('<')) { setList([]); return undefined; }
    const t = setTimeout(() => get(`/contacts/suggest?q=${encodeURIComponent(token.text)}`).then((r) => { setList(r); setPick(0); }).catch(() => setList([])), 120);
    return () => clearTimeout(t);
  }, [token?.text]);
  const track = (v, caret) => setToken(currentToken(v, caret));
  const choose = (p) => {
    const { text, caret } = insertAddress(value, token, p);
    caretTo.current = caret;
    onChange(text);
    setList([]); setToken(null);
    ref.current?.focus();
  };
  const open = list.length > 0;
  return (
    <span className="address-input">
      <input ref={ref} {...rest} aria-label={label} value={value} autoComplete="off" role="combobox" aria-expanded={open} aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); track(e.target.value, e.target.selectionStart); }}
        onBlur={() => setTimeout(() => setList([]), 150)}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setPick((i) => (i + 1) % list.length); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setPick((i) => (i - 1 + list.length) % list.length); }
          else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(list[pick]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setList([]); }
        }} />
      {open && (
        <ul className="address-list" role="listbox" aria-label={`Suggestions for ${label}`}>
          {list.map((p, i) => (
            <li key={p.email} role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(p); }}>
              <Avatar name={p.name || p.email} size={24} />
              <span className="grow"><span>{p.name || p.email}</span>{p.name && <span className="muted small"> {p.email}</span>}</span>
              <span className="muted small">{p.kind === 'colleague' ? 'Colleague' : 'Contact'}</span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
