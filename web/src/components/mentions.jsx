// Typing "@" plus a few letters in a text box suggests colleagues; picking one puts "@their@address "
// in the text. Used by comments and Chat. Mentions are written as "@" followed by the email address.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { get } from '../api.js';
import { Avatar } from './ui.jsx';

export const MENTION_RE = /(@[\w.+-]+@[\w.-]+\.[a-z]{2,})/gi;

let directory = null; // fetched once per page load
let groupList = null;
export const knownGroupWords = new Set(['channel']); // filled once the company's groups are loaded
const groupsOnce = () => (groupList ||= get('/groups').then((l) => { for (const g of l) knownGroupWords.add(g.slug); return l; }).then((l) => l.map((g) => ({ id: `g:${g.id}`, name: g.name, username: g.slug, group: true, count: g.members.length }))).catch(() => { groupList = null; return []; }));
/** In Chat: @a-group (by its name with dashes) or @channel. */
export const GROUP_WORD_RE = /(^|[^\w@.+-])(@[a-z0-9][a-z0-9-]{0,79})(?![\w@.-])/gi;
const people = () => (directory ||= get('/users/directory').catch(() => { directory = null; return []; }));

/**
 * The picker for a textarea (`ref`). Call `track` from onChange and `keyDown` first in onKeyDown
 * (it returns true when it handled the key); render `list` next to the textarea.
 */
export function useMentions(ref, value, onChange, { groups = false } = {}) {
  const [all, setAll] = useState([]);
  const [at, setAt] = useState(null); // the "@word" being typed: { start, query }
  const [pick, setPick] = useState(0);
  const caretTo = useRef(null);
  useEffect(() => {
    let live = true;
    Promise.all([people(), groups ? groupsOnce() : []]).then(([p, g]) => live && setAll([...p, ...g, ...(groups ? [{ id: 'channel', name: 'Everyone in this conversation', username: 'channel', group: true }] : [])]));
    return () => { live = false; };
  }, [groups]);
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
          {p.group ? <span className="mention-group-icon" aria-hidden="true">👥</span> : <Avatar name={p.name} size={20} userId={p.id} />} {p.name} <span className="muted small">{p.group ? `@${p.username}${p.count !== undefined ? ` · ${p.count} people` : ''}` : p.username}</span>
        </li>
      ))}
    </ul>
  );
  return { track, keyDown, list, close: () => setAt(null) };
}

/**
 * A line under a text box naming colleagues @mentioned in `text` who are away (vacation reply on) or outside
 * their working hours now, as you write. `skip`: ids not to name (yourself, the other person in a DM).
 */
export function MentionedAway({ text, skip = [], className = 'chat-late small' }) {
  const [list, setList] = useState([]);
  const [dir, setDir] = useState([]);
  useEffect(() => { let live = true; people().then((p) => live && setDir(p)); return () => { live = false; }; }, []);
  const skipKey = skip.filter(Boolean).join(',');
  useEffect(() => {
    const emails = [...new Set([...String(text || '').matchAll(MENTION_RE)].map((m) => m[1].slice(1).toLowerCase()))];
    const skipped = new Set(skipKey.split(','));
    const ids = emails.map((e) => dir.find((p) => (p.username || '').toLowerCase() === e)?.id).filter((id) => id && !skipped.has(id));
    if (!ids.length) { setList([]); return undefined; }
    let live = true;
    const t = setTimeout(() => get(`/users/availability?ids=${ids.join(',')}`).then((r) => { if (live) setList(r); }).catch(() => {}), 500);
    return () => { live = false; clearTimeout(t); };
  }, [text, dir, skipKey]);
  if (!list.length) return null;
  const day = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return (
    <p className={className} role="status" aria-label="Mentioned people who are away">
      {list.map((x, i) => (
        <span key={x.id}>{i > 0 && ' · '}<span aria-hidden="true">{x.away ? '🌴' : '🌙'}</span> <strong>{x.name}</strong>
          {x.away ? ` is away${x.away.until ? ` until ${day(x.away.until)}` : ''}` : `: it's ${x.after.local} for them, outside their working hours`}</span>
      ))}
    </p>
  );
}
