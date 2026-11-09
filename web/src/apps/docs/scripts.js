// Superscript (x², footnote-style numbers, 1st) and subscript (H₂O) in Docs: marks that can't be on
// the same text at once. Ctrl+. and Ctrl+, as in Google Docs. Footnote markers are <sup> too, but
// carry data-footnote: they stay footnotes.
import { Mark } from '@tiptap/core';

const scriptMark = (name, tag, key, other) => Mark.create({
  name,
  excludes: other,
  parseHTML: () => [
    { tag, getAttrs: (el) => (el.hasAttribute?.('data-footnote') ? false : null) },
    { style: 'vertical-align', getAttrs: (v) => (v === (tag === 'sup' ? 'super' : 'sub') ? null : false) },
  ],
  renderHTML: () => [tag, 0],
  addCommands() {
    return { [`toggle${name[0].toUpperCase()}${name.slice(1)}`]: () => ({ commands }) => commands.toggleMark(name) };
  },
  addKeyboardShortcuts() {
    return { [key]: () => this.editor.commands.toggleMark(name) };
  },
});

export const Superscript = scriptMark('superscript', 'sup', 'Mod-.', 'subscript');
export const Subscript = scriptMark('subscript', 'sub', 'Mod-,', 'superscript');
