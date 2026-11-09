// Suggesting mode ("track changes") for Docs. While someone suggests, what they type is marked as a
// suggested insertion and what they delete stays in the text, marked as a suggested deletion (struck
// through), each with who did it and when. Anyone who can edit then accepts or rejects each suggestion.
// Paragraph breaks and formatting go in directly; only text is tracked.
//
// The functions below work on a ProseMirror state and return a transaction (or null), so they can be
// tested without a browser; SuggestMode wires them to the keyboard, typing, pasting and cutting.
import { Mark, Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';

const attrs = () => ({
  id: { default: null, parseHTML: (el) => el.getAttribute('data-sugg'), renderHTML: (a) => ({ 'data-sugg': a.id }) },
  by: { default: null, parseHTML: (el) => el.getAttribute('data-by'), renderHTML: (a) => ({ 'data-by': a.by }) },
  name: { default: '', parseHTML: (el) => el.getAttribute('data-name') || '', renderHTML: (a) => ({ 'data-name': a.name, title: a.name ? `Suggested by ${a.name}` : null }) },
  at: { default: 0, parseHTML: (el) => Number(el.getAttribute('data-at')) || 0, renderHTML: (a) => ({ 'data-at': a.at }) },
});

/** Text someone suggests adding. */
export const SuggestInsert = Mark.create({
  name: 'suggestInsert',
  inclusive: false,
  addAttributes: attrs,
  parseHTML: () => [{ tag: 'ins[data-sugg]', priority: 100 }],
  renderHTML: ({ HTMLAttributes }) => ['ins', { ...HTMLAttributes, class: 'sugg-ins' }, 0],
});

/** Text someone suggests removing (it stays, struck through, until accepted). */
export const SuggestDelete = Mark.create({
  name: 'suggestDelete',
  inclusive: false,
  addAttributes: attrs,
  parseHTML: () => [{ tag: 'del[data-sugg]', priority: 100 }], // before Strike's own <del>
  renderHTML: ({ HTMLAttributes }) => ['del', { ...HTMLAttributes, class: 'sugg-del' }, 0],
});

const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const markOf = (node, name) => node?.marks?.find((m) => m.type.name === name) || null;

/** Text pieces between two positions: [{ from, to, node }]. */
function textRuns(doc, from, to) {
  const out = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const s = Math.max(pos, from);
    const e = Math.min(pos + node.nodeSize, to);
    if (e > s) out.push({ from: s, to: e, node });
  });
  return out;
}

/**
 * Mark [from, to] as suggested for deletion. Your own suggested insertions there simply go (you're
 * taking back your own suggestion); text already suggested for deletion stays as it is.
 */
export function markDeleted(tr, from, to, who, id = newId(), at = Date.now()) {
  const type = tr.doc.type.schema.marks.suggestDelete;
  const runs = textRuns(tr.doc, from, to).reverse(); // from the end, so earlier positions stay put
  for (const r of runs) {
    const ins = markOf(r.node, 'suggestInsert');
    if (ins && ins.attrs.by === who.id) tr.delete(r.from, r.to);
    else if (!markOf(r.node, 'suggestDelete')) tr.addMark(r.from, r.to, type.create({ id, by: who.id, name: who.name, at }));
  }
  return tr;
}

/** The suggestion to carry on with when typing at pos (your own one just before it): { id, at }, or a new one. */
function carryOn(doc, pos, who, name, at) {
  const m = markOf(doc.resolve(pos).nodeBefore, name);
  return m && m.attrs.by === who.id ? { id: m.attrs.id, at: m.attrs.at } : { id: newId(), at };
}

/** Typing (or pasting text) over [from, to] as a suggestion. */
export function suggestText(state, from, to, text, who, at = Date.now()) {
  const tr = state.tr;
  const { id, at: when } = carryOn(state.doc, from, who, 'suggestInsert', at);
  if (to > from) markDeleted(tr, from, to, who, id, when);
  // Insert after what's now struck through, carrying the formatting there (bold, links…) but not suggestion marks.
  const pos = tr.mapping.map(to, 1);
  const marks = (state.storedMarks || state.doc.resolve(from).marks()).filter((m) => !m.type.name.startsWith('suggest'));
  if (text) {
    const ins = state.schema.marks.suggestInsert.create({ id, by: who.id, name: who.name, at: when });
    tr.insert(pos, state.schema.text(text, [...marks, ins]));
  }
  tr.setSelection(TextSelection.create(tr.doc, pos + text.length));
  return tr;
}

const isSurrogatePair = (s) => s.length === 2 && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(s);

/**
 * Backspace (dir -1) or Delete (dir 1) as a suggestion. With a selection, it's suggested for deletion;
 * otherwise the character next to the cursor (skipping text already struck through). Returns null at
 * the edge of a paragraph, so joining paragraphs works as usual.
 */
export function suggestDeleteKey(state, dir, who, at = Date.now()) {
  const { from, to, empty } = state.selection;
  if (!empty) {
    const c = carryOn(state.doc, from, who, 'suggestDelete', at);
    const tr = markDeleted(state.tr, from, to, who, c.id, c.at);
    tr.setSelection(TextSelection.create(tr.doc, dir < 0 ? tr.mapping.map(from, -1) : tr.mapping.map(to, 1)));
    return tr;
  }
  let pos = from;
  const $start = state.doc.resolve(pos);
  const lo = $start.start();
  const hi = $start.end();
  const struck = (p) => markOf(dir < 0 ? state.doc.resolve(p).nodeBefore : state.doc.resolve(p).nodeAfter, 'suggestDelete');
  while ((dir < 0 ? pos > lo : pos < hi) && struck(pos)) pos += dir; // hop over what's already suggested away
  if (dir < 0 ? pos <= lo : pos >= hi) {
    if (pos === from) return null; // at the start (end) of the paragraph: let it join paragraphs
    return state.tr.setSelection(TextSelection.create(state.doc, pos));
  }
  let a = dir < 0 ? pos - 1 : pos;
  let b = dir < 0 ? pos : pos + 1;
  if (dir < 0 && a - 1 >= lo && isSurrogatePair(state.doc.textBetween(a - 1, b))) a -= 1;
  if (dir > 0 && b + 1 <= hi && isSurrogatePair(state.doc.textBetween(a, b + 1))) b += 1;
  const near = dir < 0 ? state.doc.resolve(b).nodeAfter : state.doc.resolve(a).nodeBefore; // carry on the same deletion
  const m = markOf(near, 'suggestDelete');
  const c = m && m.attrs.by === who.id ? { id: m.attrs.id, at: m.attrs.at } : carryOn(state.doc, a, who, 'suggestDelete', at);
  const tr = markDeleted(state.tr, a, b, who, c.id, c.at);
  tr.setSelection(TextSelection.create(tr.doc, dir < 0 ? tr.mapping.map(a, -1) : tr.mapping.map(b, 1)));
  return tr;
}

/** All suggestions in the document, in order: [{ id, by, name, at, from, to, inserted, deleted }]. */
export function listSuggestions(doc) {
  const byId = new Map();
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const name of ['suggestInsert', 'suggestDelete']) {
      const m = markOf(node, name);
      if (!m) continue;
      let s = byId.get(m.attrs.id);
      if (!s) byId.set(m.attrs.id, (s = { id: m.attrs.id, by: m.attrs.by, name: m.attrs.name, at: m.attrs.at, from: pos, to: pos + node.nodeSize, inserted: '', deleted: '' }));
      s.from = Math.min(s.from, pos);
      s.to = Math.max(s.to, pos + node.nodeSize);
      if (name === 'suggestInsert') s.inserted += node.text; else s.deleted += node.text;
    }
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}

/** Accept (keep the insertion, remove the deleted text) or reject (the opposite) one suggestion, or all with id null. */
export function resolveSuggestion(state, id, accept) {
  const tr = state.tr;
  const runs = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const name of ['suggestInsert', 'suggestDelete']) {
      const m = markOf(node, name);
      if (m && (id === null || m.attrs.id === id)) runs.push({ from: pos, to: pos + node.nodeSize, name, mark: m });
    }
  });
  if (!runs.length) return null;
  for (const r of runs.reverse()) {
    const from = tr.mapping.map(r.from);
    const to = tr.mapping.map(r.to);
    if (to <= from) continue;
    const goes = (r.name === 'suggestInsert') !== accept; // a rejected insertion, or an accepted deletion
    if (goes) tr.delete(from, to);
    else tr.removeMark(from, to, r.mark);
  }
  return tr;
}

/** "Add “x”", "Delete “y”", "Replace “y” with “x”". */
export function describeSuggestion(s, max = 60) {
  const q = (t) => `“${t.length > max ? `${t.slice(0, max)}…` : t}”`;
  if (s.inserted && s.deleted) return `Replace ${q(s.deleted)} with ${q(s.inserted)}`;
  return s.inserted ? `Add ${q(s.inserted)}` : `Delete ${q(s.deleted)}`;
}

export const suggestKey = new PluginKey('suggestMode');

/** While storage.on is true, typing, deleting, pasting and cutting become suggestions by storage.who. */
export const SuggestMode = Extension.create({
  name: 'suggestMode',
  addStorage: () => ({ on: false, who: null }),
  addProseMirrorPlugins() {
    const store = this.storage;
    const active = (view) => store.on && store.who && view.editable;
    return [new Plugin({
      key: suggestKey,
      props: {
        handleTextInput(view, from, to, text) {
          if (!active(view)) return false;
          view.dispatch(suggestText(view.state, from, to, text, store.who));
          return true;
        },
        handleKeyDown(view, event) {
          if (!active(view) || (event.key !== 'Backspace' && event.key !== 'Delete') || event.altKey) return false;
          const tr = suggestDeleteKey(view.state, event.key === 'Backspace' ? -1 : 1, store.who);
          if (!tr) return false;
          view.dispatch(tr.scrollIntoView());
          event.preventDefault();
          return true;
        },
        handlePaste(view, event) {
          if (!active(view)) return false;
          const text = event.clipboardData?.getData('text/plain');
          if (!text) return false;
          const { from, to } = view.state.selection;
          view.dispatch(suggestText(view.state, from, to, text.replace(/\r?\n+/g, ' '), store.who).scrollIntoView());
          event.preventDefault();
          return true;
        },
        handleDOMEvents: {
          cut(view, event) {
            if (!active(view) || view.state.selection.empty) return false;
            const { from, to } = view.state.selection;
            event.clipboardData?.setData('text/plain', view.state.doc.textBetween(from, to, '\n'));
            event.preventDefault();
            view.dispatch(suggestDeleteKey(view.state, -1, store.who));
            return true;
          },
          drop(view, event) { return active(view) ? (event.preventDefault(), true) : false; }, // moving text around isn't tracked
        },
      },
    })];
  },
});
