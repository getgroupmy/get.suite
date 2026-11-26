// "@" and a few letters of a name in Mail's message box (as Gmail's "+name"): colleagues who match, under the cursor;
// ↑ ↓ choose, Enter or Tab put "@Their Name" in as a link to their address and call onPick(person) (Mail adds them to
// To), Escape closes. Call keys.current(event) from the editor's handleKeyDown, and render `list`.
import { useEffect, useRef, useState } from 'react';
import { get } from '../api.js';
import { mentionQuery, matchPeople } from '../apps/docs/mention.js';

export function useEditorPeople(editor, onPick, { off = false } = {}) {
  const [pop, setPop] = useState(null); // { from, query, left, top, list, pick }
  const people = useRef(null);
  const picked = useRef(onPick);
  picked.current = onPick;
  useEffect(() => {
    if (!editor || off) return undefined;
    const check = () => {
      const { state, view } = editor;
      const sel = state.selection;
      if (!sel.empty || !sel.$from.parent.isTextblock) { setPop(null); return; }
      const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, '￼');
      const m = mentionQuery(before, sel.from);
      if (!m || !m.query) { setPop(null); return; }
      if (!people.current) { people.current = []; get('/users/directory').then((l) => { people.current = l; check(); }).catch(() => {}); return; }
      const list = matchPeople(people.current, m.query);
      if (!list.length) { setPop(null); return; }
      const c = view.coordsAtPos(sel.from);
      setPop((old) => ({ ...m, list, left: c.left, top: c.bottom + 4, pick: old && old.from === m.from ? Math.min(old.pick, list.length - 1) : 0 }));
    };
    editor.on('selectionUpdate', check);
    editor.on('update', check);
    const close = () => setPop(null);
    editor.on('blur', close);
    return () => { editor.off('selectionUpdate', check); editor.off('update', check); editor.off('blur', close); };
  }, [editor, off]);
  const pick = (p) => {
    const m = pop;
    setPop(null);
    if (!m) return;
    editor.chain().focus().deleteRange({ from: m.from, to: editor.state.selection.from })
      .insertContent([{ type: 'text', text: `@${p.name}`, marks: [{ type: 'link', attrs: { href: `mailto:${p.username}` } }] }, { type: 'text', text: ' ' }]).run();
    picked.current?.(p);
  };
  const keys = useRef(null);
  keys.current = (e) => {
    if (!pop) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { setPop({ ...pop, pick: (pop.pick + (e.key === 'ArrowDown' ? 1 : pop.list.length - 1)) % pop.list.length }); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { pick(pop.list[pop.pick]); return true; }
    if (e.key === 'Escape') { setPop(null); return true; }
    return false;
  };
  const list = pop && (
    <ul className="mention-list doc-mention-list" role="listbox" aria-label="People to add" style={{ position: 'fixed', left: pop.left, top: pop.top }}>
      {pop.list.map((p, i) => (
        <li key={p.id} role="option" aria-selected={i === pop.pick} className={i === pop.pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
          {p.name} <span className="muted small">{p.username}</span>
        </li>
      ))}
    </ul>
  );
  return { keys, list, open: !!pop };
}
