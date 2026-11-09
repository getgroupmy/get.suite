// Capitalisation (Docs, Format → Capitalisation): lowercase, UPPERCASE, Title Case and Sentence case for
// the selected text, keeping its formatting. Letters change one for one, so the text keeps its length
// (a letter whose other case is longer, like ß → SS, stays as it is).

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'vs', 'via', 'with']);
const up = (ch) => { const u = ch.toUpperCase(); return u.length === ch.length ? u : ch; };
const low = (ch) => { const l = ch.toLowerCase(); return l.length === ch.length ? l : ch; };
const map = (s, f) => Array.from(s, f).join('');
const isLetter = (ch) => /\p{L}/u.test(ch);

/** The text in another case; `start` says the text begins a sentence (for Sentence case). */
export function changeCase(text, mode, { start = true } = {}) {
  const t = String(text);
  if (mode === 'lower') return map(t, low);
  if (mode === 'upper') return map(t, up);
  if (mode === 'title') {
    let first = true;
    return t.replace(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu, (w, at) => {
      const isFirst = first; first = false;
      const afterBreak = /[:—–]\s*$/.test(t.slice(0, at));
      const lw = map(w, low);
      if (!isFirst && !afterBreak && SMALL.has(lw)) return lw;
      if (w.length > 1 && w.length <= 5 && w === map(w, up) && isLetter(w)) return w; // NASA, UK stay as they are
      const [c, ...rest] = Array.from(lw);
      return up(c) + rest.join('');
    });
  }
  if (mode === 'sentence') {
    let capNext = start, out = '';
    for (const ch of t) {
      if (isLetter(ch)) { out += capNext ? up(ch) : low(ch); capNext = false; } else out += ch;
      if (/[.!?]/.test(ch)) capNext = true;
    }
    return out.replace(/(^|[^\p{L}])i(?=[^\p{L}]|$)/gu, '$1I'); // "i" on its own is a capital
  }
  return t;
}

export const CASES = [['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['title', 'Title Case'], ['sentence', 'Sentence case']];

/** A transaction putting the selection (from..to) in another case, text node by text node so marks stay. */
export function caseTransaction(state, mode) {
  const { from, to } = state.selection;
  let tr = state.tr;
  if (from === to) return null;
  // Sentence case needs to know if the selection starts a sentence.
  const before = state.doc.textBetween(Math.max(0, from - 200), from, '\n', ' ');
  let start = !/\S/.test(before.split('\n').pop()) || /[.!?]\s*$/.test(before);
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const a = Math.max(from, pos), b = Math.min(to, pos + node.nodeSize);
    const text = node.text.slice(a - pos, b - pos);
    const next = changeCase(text, mode, { start });
    if (mode === 'sentence') { const last = text.replace(/\s+$/, '').slice(-1); if (last) start = /[.!?]/.test(last); }
    if (next !== text) tr = tr.insertText(next, tr.mapping.map(a), tr.mapping.map(b));
    return false;
  });
  return tr.setSelection(state.selection.map(tr.doc, tr.mapping));
}
