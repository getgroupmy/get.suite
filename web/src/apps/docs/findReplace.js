// Find and replace in a document: every match is highlighted (the current one more strongly),
// and replacing works through the editor, so it is shared live and undone like typing.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const findKey = new PluginKey('find');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The pattern for what's searched: { re } or { error } when a regular expression isn't valid.
 * With `regex` the term is a regular expression (JavaScript's, with Unicode); otherwise plain text.
 */
export function findPattern(term, { matchCase = false, wholeWord = false, regex = false, wholeText = false } = {}) {
  const body = regex ? term : escapeRe(term);
  try {
    // wholeText: the whole of the text, nothing else (a sheet's "Match entire cell")
    const re = new RegExp(wholeText ? `^(?:${body})$` : `${wholeWord ? '(?<![\\p{L}\\p{N}_])(?:' : ''}${body}${wholeWord ? ')(?![\\p{L}\\p{N}_])' : ''}`, `gu${matchCase ? '' : 'i'}`);
    return { re };
  } catch {
    return { error: 'That isn’t a valid regular expression' };
  }
}

/** What replaces a match: the text as typed, or with a regular expression $1…$9 (its groups), $& (the whole match) and $$ ($). */
export function replacementFor(replace, match, regex) {
  if (!regex) return replace;
  const g = match.groups || [];
  return String(replace).replace(/\$(\$|&|[1-9])/g, (_, k) => (k === '$' ? '$' : k === '&' ? g[0] ?? '' : g[Number(k)] ?? ''));
}

/** Text without its accents (é → e), with where each of its characters came from: { text, from: [index] }. */
export function foldAccents(text) {
  let out = '';
  const from = [];
  for (let i = 0; i < text.length; i++) {
    const f = text[i].normalize('NFD').replace(/\p{M}/gu, '');
    for (let k = 0; k < f.length; k++) from.push(i);
    out += f;
  }
  from.push(text.length);
  return { text: out, from };
}

/**
 * Where `term` occurs in a piece of text: [{ from, to, groups }] (positions in the text as written). Accents don't
 * matter unless `matchDiacritics`, or with a regular expression (then the text is read exactly).
 */
export function matchesInText(text, term, options = {}) {
  if (!term) return [];
  const fold = !options.matchDiacritics && !options.regex;
  const { re } = findPattern(fold ? foldAccents(term).text : term, options);
  if (!re) return [];
  const folded = fold ? foldAccents(text) : null;
  const out = [];
  for (const m of (folded ? folded.text : text).matchAll(re)) {
    if (!m[0].length) continue; // an empty match (say, "a*") finds nothing
    const from = folded ? folded.from[m.index] : m.index;
    let last = folded ? folded.from[m.index + m[0].length - 1] : m.index + m[0].length - 1;
    if (folded) while (last + 1 < text.length && /\p{M}/u.test(text[last + 1])) last++; // and accents written as marks after it
    out.push({ from, to: last + 1, groups: [...m] });
  }
  return out;
}

/**
 * Where `term` occurs in the document: [{ from, to, groups }]. Matches stay inside one block (paragraph,
 * heading, cell); `matchCase`, `wholeWord` and `regex` work as in other editors. Accents don't matter
 * (cafe finds café) unless `matchDiacritics`, or with a regular expression.
 */
export function findMatches(doc, term, options = {}) {
  if (!term) return [];
  if (!findPattern(term, options).re) return [];
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
    for (const m of matchesInText(text, term, options)) {
      if (text.slice(m.from, m.to).includes('￼')) continue;
      if (out.length >= 5000) break;
      out.push({ from: at[m.from], to: at[m.to - 1] + 1, ...(options.regex && { groups: m.groups }) });
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
