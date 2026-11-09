// Paragraph indentation (Docs): Increase / Decrease indent (Ctrl+] / Ctrl+[) moves paragraphs and
// headings in by steps of half an inch (36 px), up to 8 steps. Lists keep their own (Tab nests them).
import { Extension } from '@tiptap/core';

export const MAX_INDENT = 8, STEP_PX = 36;
const TYPES = ['paragraph', 'heading'];

/** The indent kept: a whole number of steps from 0 to MAX_INDENT. */
export const cleanIndent = (n) => Math.max(0, Math.min(MAX_INDENT, Math.round(Number(n) || 0)));

/** A transaction moving the paragraphs and headings in the selection by `by` steps (not those in lists or tables), or null. */
export function indentTransaction(state, by) {
  const { from, to } = state.selection;
  let tr = state.tr, changed = false;
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!TYPES.includes(node.type.name)) return true;
    if (!['doc', 'blockquote'].includes(parent?.type.name)) return false; // in a list item or a table cell
    const next = cleanIndent((node.attrs.indent || 0) + by);
    if (next !== (node.attrs.indent || 0)) { tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next }); changed = true; }
    return false;
  });
  return changed ? tr : null;
}

export const Indent = Extension.create({
  name: 'indent',
  addGlobalAttributes() {
    return [{
      types: TYPES,
      attributes: {
        indent: {
          default: 0,
          parseHTML: (el) => cleanIndent(el.getAttribute('data-indent') ?? (parseFloat(el.style?.marginLeft) || 0) / STEP_PX),
          renderHTML: (attrs) => (attrs.indent ? { 'data-indent': attrs.indent, style: `margin-left: ${attrs.indent * STEP_PX}px` } : {}),
        },
      },
    }];
  },
  addCommands() {
    const run = (by) => () => ({ state, dispatch }) => { const tr = indentTransaction(state, by); if (!tr) return false; if (dispatch) dispatch(tr); return true; };
    return { increaseIndent: run(1), decreaseIndent: run(-1) };
  },
  addKeyboardShortcuts() {
    return { 'Mod-]': () => this.editor.commands.increaseIndent(), 'Mod-[': () => this.editor.commands.decreaseIndent() };
  },
});
