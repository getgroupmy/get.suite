// Long sentences: a writing aid that marks sentences of 25 words or more (and 35 or more more strongly),
// which readers find hard to follow, and words typed twice in a row. Turned on in the Word count window; remembered in this browser.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { sentencesFrom } from './readaloud.js';

export const LONG = 25, VERY_LONG = 35;
export const longKey = new PluginKey('longSentences');
const PREF = 'nw-doc-long-sentences';
export const longOn = () => { try { return localStorage.getItem(PREF) === '1'; } catch { return false; } };
export const rememberLong = (on) => { try { localStorage.setItem(PREF, on ? '1' : '0'); } catch { /* private window */ } };

const wordsIn = (t) => (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_.]*/gu) || []).length;

/** The document's long sentences: [{ from, to, words, very }]. */
export function longSentences(doc, limit = LONG) {
  return sentencesFrom(doc, 0).map((s) => ({ from: s.from, to: s.to, words: wordsIn(s.text) }))
    .filter((s) => s.words >= limit).map((s) => ({ ...s, very: s.words >= VERY_LONG }));
}

/**
 * Words typed twice in a row ("the the"), a typo spell checkers miss: [{ from, to, word }] (the second one).
 * Ignoring case; not numbers, and not the few words that are fine doubled ("had had", "that that").
 */
const FINE_TWICE = new Set(['had', 'that', 'is', 'bye', 'no', 'very', 'so', 'ha', 'la', 'cha', 'tut', 'well', 'blah', 'yada', 'knock']);
export function repeatedWords(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = ''; const at = [];
    node.descendants((child, offset) => { if (child.isText) { for (let i = 0; i < child.text.length; i++) at.push(pos + 1 + offset + i); text += child.text; } else if (child.isLeaf) { at.push(-1); text += '\n'; } return true; });
    // Each word and the one after it (looked at without taking it, so every pair is seen).
    for (const m of text.matchAll(/(?<![\p{L}\p{N}'’])(\p{L}+)(?=([ \t]+)(\p{L}+)(?![\p{L}\p{N}'’]))/gu)) {
      if (m[1].toLowerCase() !== m[3].toLowerCase() || FINE_TWICE.has(m[1].toLowerCase())) continue;
      const start = m.index + m[1].length + m[2].length;
      out.push({ from: at[start], to: at[start + m[3].length - 1] + 1, word: m[3] });
    }
    return false;
  });
  return out;
}

/** The highlight: { on, list }. Turn it on or off with tr.setMeta(longKey, { on }). */
export const LongSentences = Extension.create({
  name: 'longSentences',
  addProseMirrorPlugins() {
    let timer = null;
    return [new Plugin({
      key: longKey,
      state: {
        init: (_, state) => { const on = longOn(); return { on, list: on ? longSentences(state.doc) : [], twice: on ? repeatedWords(state.doc) : [] }; },
        apply(tr, prev, _old, state) {
          const meta = tr.getMeta(longKey);
          if (meta && 'on' in meta) return { on: meta.on, list: meta.on ? longSentences(state.doc) : [], twice: meta.on ? repeatedWords(state.doc) : [] };
          if (meta?.refresh && prev.on) return { ...prev, list: longSentences(state.doc), twice: repeatedWords(state.doc), stale: false };
          if (!prev.on || !tr.docChanged) return prev;
          // While typing: the marks move with the text; they're worked out again a moment after typing stops.
          const move = (l) => l.map((s) => ({ ...s, from: tr.mapping.map(s.from), to: tr.mapping.map(s.to, -1) })).filter((s) => s.to > s.from);
          return { ...prev, list: move(prev.list), twice: move(prev.twice || []), stale: true };
        },
      },
      view: () => ({
        update(view) {
          const st = longKey.getState(view.state);
          if (!st?.stale) return;
          clearTimeout(timer);
          timer = setTimeout(() => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(longKey, { refresh: true }).setMeta('addToHistory', false)); }, 400);
        },
        destroy() { clearTimeout(timer); },
      }),
      props: {
        decorations(state) {
          const st = longKey.getState(state);
          if (!st?.on || (!st.list.length && !st.twice?.length)) return null;
          return DecorationSet.create(state.doc, [
            ...st.list.map((s) => Decoration.inline(s.from, s.to, {
              class: s.very ? 'long-sentence very' : 'long-sentence',
              title: `${s.words} words: ${s.very ? 'very hard' : 'hard'} to follow. Try splitting it.`,
            })),
            ...(st.twice || []).map((w) => Decoration.inline(w.from, w.to, { class: 'repeated-word', title: `“${w.word}” twice in a row` })),
          ]);
        },
      },
    })];
  },
});
