// An emoji button with a popup: search by name, groups, recently used. Used in Mail and Chat.
import { useEffect, useMemo, useRef, useState } from 'react';
import { EMOJI_GROUPS, ALL_EMOJI, searchEmoji } from './emoji.js';

const COLS = 8;
const RECENT_KEY = 'nw.emojiRecent';
const readRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
const saveRecent = (list) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* private window */ } };
const byChar = new Map(ALL_EMOJI.map((e) => [e.char, e]));

/**
 * `onPick(char)` inserts it. `keepFocus` stops the button from taking focus (the Mail editor keeps
 * its selection); `beforePick` runs first (e.g. to put focus back in the editor). `up` opens the
 * popup above the button (for a message box at the bottom of the screen).
 */
export default function EmojiPicker({ onPick, beforePick, keepFocus, up, className = 'tb', label = 'Insert emoji' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(null); // group name or 'Recent'
  const [recent, setRecent] = useState(readRecent);
  const [at, setAt] = useState(0); // highlighted emoji in the grid
  const wrap = useRef(), pop = useRef(), grid = useRef(), search = useRef(), button = useRef();

  const current = tab ?? (recent.length ? 'Recent' : EMOJI_GROUPS[0][0]);
  const list = useMemo(() => {
    if (query.trim()) return searchEmoji(query);
    if (current === 'Recent') return recent.map((c) => byChar.get(c)).filter(Boolean);
    return ALL_EMOJI.filter((e) => e.group === current);
  }, [query, current, recent]);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    // Stay on screen sideways (toolbars wrap on phones).
    const el = pop.current;
    if (el) {
      el.style.transform = '';
      const r = el.getBoundingClientRect(), room = document.documentElement.clientWidth - 8;
      const dx = r.right > room ? room - r.right : r.left < 8 ? 8 - r.left : 0;
      if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    }
    search.current?.focus();
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => { setAt(0); }, [query, current]);

  const close = (focusButton) => { setOpen(false); setQuery(''); setTab(null); if (focusButton) button.current?.focus(); };
  const pick = (e) => {
    const next = [e.char, ...recent.filter((c) => c !== e.char)].slice(0, 24);
    setRecent(next); saveRecent(next);
    close(false);
    beforePick?.();
    onPick(e.char);
  };
  const focusCell = (i) => { setAt(i); grid.current?.querySelector(`[data-i="${i}"]`)?.focus(); };

  const onKey = (e) => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (!open) return;
    if (e.target === search.current) {
      if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); focusCell(0); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (list.length) pick(list[0]); }
      return;
    }
    if (!e.target.closest?.('[role="grid"]')) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS }[e.key];
    if (step) {
      e.preventDefault();
      const n = at + step;
      if (n < 0) search.current?.focus();
      else if (n < list.length) focusCell(n);
    } else if (e.key === 'Home') { e.preventDefault(); focusCell(0); }
    else if (e.key === 'End') { e.preventDefault(); focusCell(list.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (list[at]) pick(list[at]); }
  };

  const tabs = [...(recent.length ? ['Recent'] : []), ...EMOJI_GROUPS.map(([g]) => g)];
  const tabIcon = { Recent: '🕘', Smileys: '😀', People: '👋', 'Hearts and symbols': '❤️', 'Animals and nature': '🐶', 'Food and drink': '☕', 'Activities and travel': '✈️', Objects: '💡' };
  const rows = [];
  for (let i = 0; i < list.length; i += COLS) rows.push(list.slice(i, i + COLS));

  return (
    <span className="emoji-picker" ref={wrap} onKeyDown={onKey}>
      <button type="button" ref={button} className={`${className} ${open ? 'on' : ''}`} title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined} onClick={() => (open ? close(false) : setOpen(true))}>🙂</button>
      {open && (
        <div className={`emoji-pop ${up ? 'up' : ''}`} ref={pop} role="dialog" aria-label="Emoji">
          <input ref={search} className="emoji-search" type="search" placeholder="Search emoji" aria-label="Search emoji" value={query}
            onChange={(e) => setQuery(e.target.value)} />
          {!query.trim() && (
            <div className="emoji-tabs" role="tablist" aria-label="Emoji groups">
              {tabs.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={current === t} aria-label={t} title={t} className={current === t ? 'on' : ''}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => setTab(t)}>{tabIcon[t]}</button>
              ))}
            </div>
          )}
          <div className="emoji-head small muted" aria-live="polite">{query.trim() ? (list.length ? `${list.length} found` : 'No emoji found') : current}</div>
          <div className="emoji-grid" ref={grid} role="grid" aria-label={query.trim() ? 'Search results' : current}>
            {rows.map((row, r) => (
              <div role="row" key={r}>
                {row.map((e, c) => {
                  const i = r * COLS + c;
                  return (
                    <button key={e.char} type="button" role="gridcell" data-i={i} tabIndex={i === at ? 0 : -1} aria-label={e.name} title={e.name}
                      onMouseDown={(ev) => ev.preventDefault()} onFocus={() => setAt(i)} onClick={() => pick(e)}>{e.char}</button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
