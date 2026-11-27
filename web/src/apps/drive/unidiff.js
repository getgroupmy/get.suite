// A comparison's lines ({ op: '=' | '-' | '+', text, a, b }, from the server's diffLines) as a unified diff, the
// .diff / .patch text that `patch`, `git apply` and code review tools read: --- / +++ names, then a hunk for each
// group of changes with CONTEXT unchanged lines around it (@@ -start,count +start,count @@).

export function unifiedDiff(lines, fromName, toName, context = 3) {
  const out = [`--- ${fromName}`, `+++ ${toName}`];
  const changed = lines.map((l, i) => (l.op !== '=' ? i : -1)).filter((i) => i >= 0);
  if (!changed.length) return '';
  // Groups of changes whose contexts touch or overlap make one hunk.
  const hunks = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context), hi = Math.min(lines.length - 1, i + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last.hi + 1) last.hi = hi; else hunks.push({ lo, hi });
  }
  for (const { lo, hi } of hunks) {
    const part = lines.slice(lo, hi + 1);
    const fromLines = part.filter((l) => l.op !== '+'), toLines = part.filter((l) => l.op !== '-');
    // Where each side starts: the first line it has in this hunk, or (when it has none) the line before.
    const startOf = (side, have) => {
      if (have.length) return have[0][side];
      for (let k = lo - 1; k >= 0; k--) if (lines[k][side] != null) return lines[k][side];
      return 0;
    };
    const range = (start, n) => (n === 1 ? `${start}` : `${start},${n}`);
    out.push(`@@ -${range(startOf('a', fromLines), fromLines.length)} +${range(startOf('b', toLines), toLines.length)} @@`);
    for (const l of part) out.push(`${l.op === '=' ? ' ' : l.op}${l.text}`);
  }
  return `${out.join('\n')}\n`;
}
