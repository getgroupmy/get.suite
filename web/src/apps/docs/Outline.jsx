// The outline beside a document: its headings, indented by level. Clicking one goes there; the one
// the cursor is under is marked. It follows changes as they're made, by you or anyone else.
import { useEffect, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { headingsOf, currentHeading, anchorsOf } from './outline.js';

/** Put the cursor at the end of a heading and bring it to the top of the window. */
export function goToHeading(editor, h) {
  const { view } = editor;
  const at = Math.min(h.pos + 1 + editor.state.doc.nodeAt(h.pos).content.size, editor.state.doc.content.size);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
  view.focus();
  // After focusing (which keeps the cursor in view), put the heading at the top.
  const el = view.nodeDOM(h.pos);
  if (el?.scrollIntoView) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
}

export function Outline({ editor, onClose, fileId, onCopied }) {
  const [, force] = useState(0);
  useEffect(() => {
    const again = () => force((n) => n + 1);
    editor.on('update', again);
    editor.on('selectionUpdate', again);
    return () => { editor.off('update', again); editor.off('selectionUpdate', again); };
  }, [editor]);
  const headings = headingsOf(editor.state.doc);
  const here = currentHeading(headings, editor.state.selection.from);
  const top = Math.min(...headings.map((h) => h.level));
  const go = (h) => goToHeading(editor, h);
  const anchors = anchorsOf(headings);
  // A link straight to a heading, for sending to someone (it opens the document there).
  const copyLink = async (i) => {
    const url = `${window.location.origin}/docs/${fileId}#${anchors[i]}`;
    try { await navigator.clipboard.writeText(url); onCopied?.(`Link to “${headings[i].text}” copied`); } catch { window.prompt('Copy this link', url); }
  };
  return (
    <nav className="doc-outline" aria-label="Outline">
      <div className="row"><strong className="grow">Outline</strong><button type="button" className="icon-btn" style={{ width: 28, height: 28 }} aria-label="Close outline" onClick={onClose}>×</button></div>
      {headings.length === 0
        ? <p className="muted small">Headings you add to the document appear here.</p>
        : (
          <ul>
            {headings.map((h, i) => (
              <li key={`${h.pos}`} style={{ paddingLeft: (h.level - top) * 14 }}>
                <button type="button" className={i === here ? "on" : undefined} aria-current={i === here ? 'location' : undefined} onClick={() => go(h)} title={h.text}>{h.text}</button>
                {fileId && <button type="button" className="outline-link" aria-label={`Copy link to ${h.text}`} title="Copy a link to this heading" onClick={() => copyLink(i)}>🔗</button>}
              </li>
            ))}
          </ul>
        )}
    </nav>
  );
}
