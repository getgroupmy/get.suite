// ":" and a word in a rich-text (TipTap) editor: Docs and Mail compose. Matching emoji under the cursor;
// ↑ ↓ choose, Enter or Tab put the one picked in place of what was typed, Escape closes.
// Call keys.current(event) from the editor's handleKeyDown (it returns true when it used the key), and
// render `list`.
import { useEffect, useRef, useState } from 'react';
import { emojiQuery, matchEmoji } from './emojitype.js';

export function useEditorEmoji(editor, { off = false } = {}) {
  const [pop, setPop] = useState(null); // { from, query, left, top, list, pick }
  useEffect(() => {
    if (!editor || off) return undefined;
    const check = () => {
      const { state, view } = editor;
      const sel = state.selection;
      if (!sel.empty || !sel.$from.parent.isTextblock || sel.$from.parent.type.name === 'codeBlock') { setPop(null); return; }
      const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, '￼');
      const m = emojiQuery(before, sel.from);
      const list = m ? matchEmoji(m.query) : [];
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
  const pick = (em) => {
    const m = pop;
    setPop(null);
    if (!m) return;
    editor.chain().focus().deleteRange({ from: m.from, to: editor.state.selection.from }).insertContent(em.char).run();
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
    <ul className="mention-list doc-mention-list" role="listbox" aria-label="Emoji" style={{ position: 'fixed', left: pop.left, top: pop.top }}>
      {pop.list.map((em, i) => (
        <li key={em.char} role="option" aria-selected={i === pop.pick} className={i === pop.pick ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(em); }}>
          <span aria-hidden="true" style={{ width: 20, textAlign: 'center', fontSize: 18 }}>{em.char}</span> {em.name}
        </li>
      ))}
    </ul>
  );
  return { keys, list, open: !!pop };
}
