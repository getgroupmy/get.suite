// Ctrl+/ (⌘/ on a Mac), or "?" where it isn't something you'd type, lists the keyboard shortcuts,
// the current app's first.
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { Modal } from './ui.jsx';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = MAC ? '⌘' : 'Ctrl';
const alt = MAC ? '⌥' : 'Alt';

/** Shortcuts by app: [keys, what it does]. Keys are joined with + ; "/" separates alternatives. */
export const SHORTCUTS = {
  docs: { title: 'Docs', keys: [
    [`${mod}+B / ${mod}+I / ${mod}+U`, 'Bold, italic, underline'],
    [`${mod}+Z`, 'Undo your last change'], [`${mod}+Y / ${mod}+Shift+Z`, 'Redo'],
    [`${mod}+F`, 'Find in the document'], [`${mod}+H`, 'Find and replace'],
    [`${mod}+${alt}+M`, 'Comment on the selected text'],
    [`${mod}+Shift+L / E / R`, 'Align left, centre, right'],
    ['Tab / Shift+Tab', 'Next or previous table cell'],
  ] },
  sheets: { title: 'Sheets', keys: [
    ['Arrow keys', 'Move between cells'], ['Shift+arrows', 'Select a range'], [`${mod}+A`, 'Select everything'],
    ['Enter / F2', 'Edit the cell'], ['Typing', 'Replace the cell'], ['Tab / Shift+Tab', 'Next or previous cell'], ['Delete', 'Clear the selected cells'],
    [`${mod}+C / ${mod}+X / ${mod}+V`, 'Copy, cut, paste (formulas move with the cells)'],
    [`${mod}+B / ${mod}+I / ${mod}+U`, 'Bold, italic, underline'],
    [`${mod}+Z`, 'Undo your last change'], [`${mod}+Y / ${mod}+Shift+Z`, 'Redo'],
    [`${mod}+F / ${mod}+H`, 'Find, or find and replace'], [`${alt}+Shift+5`, 'Strikethrough'],
    ['Typing a formula', 'Suggests functions: arrows, then Tab or Enter'],
    [`${mod}+${alt}+M`, 'Comment on the cell'], ['Shift+F10', 'Menu: insert or delete rows and columns, sort, freeze'],
  ] },
  slides: { title: 'Slides', keys: [
    ['Arrow keys', 'Nudge the selected item (Shift: further)'], ['Enter', 'Type in the selected text box'], ['Delete', 'Remove the selected item'],
    ['Escape', 'Deselect'], ['Page Up / Page Down', 'Previous or next slide'],
    [`${mod}+Z`, 'Undo your last change'], [`${mod}+Y / ${mod}+Shift+Z`, 'Redo'],
    ['While presenting: arrows, space, click', 'Next or previous slide'], ['While presenting: N', 'Show or hide your notes'], ['While presenting: Escape', 'End the presentation'],
  ] },
  mail: { title: 'Mail', keys: [
    ['C', 'Write a new message'], ['/', 'Search mail'], ['J / K', 'Older or newer message'], ['U', 'Back to the list'],
    ['R / A / F', 'Reply, reply all, forward'], ['E', 'Archive'], ['#', 'Delete'], ['S', 'Star or unstar'], ['Shift+U', 'Mark unread'],
    [`${mod}+K`, 'Add a link while writing'], [`${mod}+] / ${mod}+[`, 'Indent or outdent'],
    [`${mod}+B / ${mod}+I / ${mod}+U`, 'Bold, italic, underline'],
  ] },
  calendar: { title: 'Calendar', keys: [
    ['← / →', 'Previous or next week or day'], ['Escape', 'Cancel a drag'],
  ] },
  chat: { title: 'Chat', keys: [['Enter', 'Send'], ['Shift+Enter', 'New line']] },
  all: { title: 'Everywhere', keys: [[`${mod}+/`, 'This list (or ? outside a text field)'], ['Escape', 'Close a dialog or menu']] },
};

const appOf = (path) => (/^\/docs\//.test(path) ? 'docs' : /^\/sheets\//.test(path) ? 'sheets' : /^\/slides\//.test(path) ? 'slides'
  : /^\/mail/.test(path) ? 'mail' : /^\/calendar/.test(path) ? 'calendar' : /^\/chat/.test(path) ? 'chat' : null);

export function ShortcutsHelp() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      const combo = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === '/' || e.code === 'Slash');
      const question = e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!combo && !question) return;
      const t = e.target;
      // "?" is typed in text fields and spreadsheet cells; Ctrl+/ works there too.
      if (question && t.closest?.('input, textarea, select, [contenteditable="true"], .grid-wrap')) return;
      if (document.querySelector('.modal-backdrop')) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!open) return null;
  const here = appOf(pathname);
  const order = [here, ...Object.keys(SHORTCUTS).filter((k) => k !== here && k !== 'all'), 'all'].filter(Boolean);
  return (
    <Modal title="Keyboard shortcuts" wide onClose={() => setOpen(false)}>
      <div className="shortcuts">
        {order.map((k) => (
          <section key={k}>
            <h3>{SHORTCUTS[k].title}</h3>
            <dl>{SHORTCUTS[k].keys.map(([keys, what]) => (
              <div key={keys} className="row"><dt>{keys.split(' / ').map((alt1, i) => <span key={i}>{i > 0 && <span className="muted"> or </span>}{alt1.split('+').map((key, j) => <span key={j}>{j > 0 && '+'}<kbd>{key}</kbd></span>)}</span>)}</dt><dd>{what}</dd></div>
            ))}</dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
