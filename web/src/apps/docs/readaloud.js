// Read aloud: the document read out by the browser's own voices (speechSynthesis), a sentence at a time,
// from where the cursor is, with the sentence being read highlighted (and kept in view).
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const readKey = new PluginKey('readAloud');
export const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/**
 * Where a text's sentences start and end: [{ start, end }] (end exclusive, trailing spaces left out). A
 * sentence ends at . ! ? … (with closing quotes or brackets) followed by a space, except after common
 * abbreviations (e.g., Mr., Dr., No.) and initials, so "Dr. Lee met J. Smith." stays one sentence.
 */
export function splitSentences(text) {
  const out = [];
  const ABBR = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|sr|jr|st|no|vol|fig|approx|inc|ltd|co|dept|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[\p{Lu}])\.$/iu;
  let start = 0;
  const re = /[.!?…]+["'”’)\]]*(?=\s)/gu;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (m[0][0] === '.' && m[0].length === 1 && ABBR.test(text.slice(Math.max(start, end - 8), end))) continue;
    const s = text.slice(start, end);
    if (s.trim()) out.push({ start: start + (s.length - s.trimStart().length), end });
    start = end;
  }
  const rest = text.slice(start);
  if (rest.trim()) out.push({ start: start + (rest.length - rest.trimStart().length), end: start + rest.trimEnd().length });
  return out;
}

/**
 * The document's sentences from position `from` on, each with its text and where it is in the document:
 * [{ text, from, to }]. Each paragraph, heading, list item or table cell is read on its own (a heading
 * without a full stop doesn't run into the next line); pictures, equations and other things that aren't
 * text are skipped.
 */
export function sentencesFrom(doc, from = 0) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (pos + node.nodeSize <= from) return false;
    // The block's text, and the document position of each of its characters.
    let text = '';
    const at = [];
    node.descendants((child, offset) => {
      if (child.isText) { for (let i = 0; i < child.text.length; i++) at.push(pos + 1 + offset + i); text += child.text; }
      else if (child.isLeaf && child.type.name === 'hardBreak') { at.push(pos + 1 + offset); text += ' '; }
      return true;
    });
    for (const s of splitSentences(text)) {
      const a = at[s.start], b = at[s.end - 1] + 1;
      if (b <= from) continue;
      const fromChar = a < from ? at.findIndex((p) => p >= from) : s.start;
      const t = text.slice(fromChar, s.end).trim();
      if (t) out.push({ text: t, from: at[fromChar], to: b });
    }
    return false;
  });
  return out;
}

/** The highlight of the sentence being read: { from, to } or null. Set with tr.setMeta(readKey, { from, to }). */
export const ReadAloud = Extension.create({
  name: 'readAloud',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: readKey,
      state: {
        init: () => null,
        apply(tr, prev) {
          const meta = tr.getMeta(readKey);
          if (meta !== undefined) return meta;
          if (!prev || !tr.docChanged) return prev;
          const from = tr.mapping.map(prev.from), to = tr.mapping.map(prev.to, -1);
          return to > from ? { from, to } : null;
        },
      },
      props: {
        decorations(state) {
          const r = readKey.getState(state);
          return r ? DecorationSet.create(state.doc, [Decoration.inline(r.from, r.to, { class: 'reading-now' })]) : null;
        },
      },
    })];
  },
});
