// What changed between two versions of a document, for "Show changes" in version history: the text
// of each paragraph (headings, list items, table cells…), matched paragraph by paragraph, and within
// a changed paragraph word by word. Pure functions on the editor's JSON.

/** The document's paragraphs as text: [{ kind: 'heading'|'item'|'para', text }]. */
export function blocksOf(json) {
  const out = [];
  const textOf = (n) => (n.type === 'text' ? n.text || '' : n.type === 'hardBreak' ? ' ' : n.type === 'footnote' ? '' : (n.content || []).map(textOf).join(''));
  const walk = (n, inItem) => {
    for (const c of n?.content || []) {
      if (c.type === 'heading') out.push({ kind: 'heading', level: c.attrs?.level || 1, text: textOf(c) });
      else if (c.type === 'paragraph') out.push({ kind: inItem ? 'item' : 'para', text: textOf(c) });
      else if (c.type === 'codeBlock') out.push({ kind: 'para', text: textOf(c) });
      else if (c.type === 'image') out.push({ kind: 'para', text: '[picture]' });
      else walk(c, inItem || c.type === 'listItem' || c.type === 'taskItem');
    }
  };
  walk(json, false);
  return out.filter((b) => b.text.trim() || b.kind === 'heading');
}

/** Longest common subsequence pairs of two lists (by `same`). */
function lcs(a, b, same) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) { ops.push(['same', a[i], b[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['del', a[i++]]);
    else ops.push(['add', b[j++]]);
  }
  while (i < n) ops.push(['del', a[i++]]);
  while (j < m) ops.push(['add', b[j++]]);
  return ops;
}

/** Word by word: [{ t: 'same'|'add'|'del', text }], neighbours of a kind joined. */
export function diffWords(before, after) {
  const words = (s) => s.match(/\s+|[^\s]+/g) || [];
  const parts = [];
  for (const [t, x, y] of lcs(words(before), words(after), (p, q) => p === q)) {
    const text = t === 'add' ? x : t === 'same' ? y : x;
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.text += text; else parts.push({ t, text });
  }
  return parts;
}

/**
 * The changes from `before` to `after` (editor JSON): [{ kind, level, change: 'same'|'add'|'del'|'edit', parts }],
 * where an edited paragraph (one taken out and one put in its place) shows its words.
 */
export function diffDocs(before, after) {
  const ops = lcs(blocksOf(before), blocksOf(after), (p, q) => p.text === q.text && p.kind === q.kind);
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const [t, x, y] = ops[k];
    if (t === 'same') { out.push({ kind: y.kind, level: y.level, change: 'same', parts: [{ t: 'same', text: y.text }] }); continue; }
    // A run of removed and added paragraphs: pair them up as edits, the rest as whole removals/additions.
    const dels = [], adds = [];
    for (; k < ops.length && ops[k][0] !== 'same'; k++) (ops[k][0] === 'del' ? dels : adds).push(ops[k][1]);
    k--;
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) out.push({ kind: adds[p].kind, level: adds[p].level, change: 'edit', parts: diffWords(dels[p].text, adds[p].text) });
    for (const d of dels.slice(pairs)) out.push({ kind: d.kind, level: d.level, change: 'del', parts: [{ t: 'del', text: d.text }] });
    for (const a of adds.slice(pairs)) out.push({ kind: a.kind, level: a.level, change: 'add', parts: [{ t: 'add', text: a.text }] });
    void x;
  }
  return out;
}

/** How much changed: { added, removed } words. */
export function changeCount(diff) {
  const count = (t) => diff.flatMap((b) => b.parts).filter((p) => p.t === t).reduce((n, p) => n + (p.text.match(/\S+/g) || []).length, 0);
  return { added: count('add'), removed: count('del') };
}
