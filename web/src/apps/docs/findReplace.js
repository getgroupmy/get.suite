// Find and replace in a document: every match is highlighted (the current one more strongly),
// and replacing works through the editor, so it is shared live and undone like typing.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const findKey = new PluginKey('find');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where `term` occurs in the document: [{ from, to }]. Matches stay inside one block (paragraph,
 * heading, cell); `matchCase` and `wholeWord` work as in other editors.
 */
export function findMatches(doc, term, { matchCase = false, wholeWord = false } = {}) {
  if (!term) return [];
  const re = new RegExp(`${wholeWord ? '(?<![\\p{L}\\p{N}_])' : ''}${escapeRe(term)}${wholeWord ? '(?![\\p{L}\\p{N}_])' : ''}`, `gu${matchCase ? '' : 'i'}`);
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // The block's text, with a map from each character back to its document position.
    let text = '';
    const at = [];
    node.forEach((child, offset) => {
      if (child.isText) { for (let i = 0; i < child.text.length; i++) at.push(pos + 1 + offset + i); text += child.text; }
      else { at.push(null); text += '￼'; } // a picture or line break: never part of a match
    });
    for (const m of text.matchAll(re)) {
      if (!m[0].length || m[0].includes('￼')) continue;
      out.push({ from: at[m.index], to: at[m.index + m[0].length - 1] + 1 });
    }
    return false;
  });
  return out;
}

/** The highlight state: { term, options, matches, current }. Updated with tr.setMeta(findKey, {...}). */
export const FindReplace = Extension.create({
  name: 'findReplace',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findKey,
      state: {
        init: () => ({ term: '', options: {}, matches: [], current: 0 }),
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(findKey);
          if (!meta && !tr.docChanged) return prev;
          const next = { ...prev, ...meta };
          next.matches = findMatches(state.doc, next.term, next.options);
          next.current = Math.min(Math.max(0, next.current ?? 0), Math.max(0, next.matches.length - 1));
          return next;
        },
      },
      props: {
        decorations(state) {
          const f = findKey.getState(state);
          if (!f?.matches.length) return null;
          return DecorationSet.create(state.doc, f.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === f.current ? 'find-match current' : 'find-match' })));
        },
      },
    })];
  },
});

/** Words in a document, and characters (without spaces), as Docs and Word count them. */
export function countWords(doc) {
  const text = doc.textBetween(0, doc.content.size, ' ', ' ');
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_.]*/gu) || [];
  return { words: words.length, characters: text.replace(/\s/g, '').length };
}
