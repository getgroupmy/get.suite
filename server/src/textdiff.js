// Line-by-line differences between two texts (an earlier version of a code or data file and the current one):
// [{ op: '=' | '-' | '+', text, a (line number before, or null), b (line number after, or null) }], from the longest
// common run of lines. Same start and end are trimmed first; when what's left is too big to compare closely
// (more than MAX_CELLS line pairs), it's shown as all removed and then all added, and `rough` says so.

const MAX_CELLS = 4_000_000;

export function diffLines(before, after) {
  const A = splitLines(before), B = splitLines(after);
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const out = [];
  for (let i = 0; i < start; i++) out.push({ op: '=', text: A[i], a: i + 1, b: i + 1 });
  const a = A.slice(start, endA), b = B.slice(start, endB);
  const n = a.length, m = b.length;
  let rough = false;
  const mid = [];
  if (n * m > MAX_CELLS) {
    rough = true;
    a.forEach((t, i) => mid.push({ op: '-', text: t, a: start + i + 1, b: null }));
    b.forEach((t, j) => mid.push({ op: '+', text: t, a: null, b: start + j + 1 }));
  } else if (n || m) {
    // lcs[i][j]: the longest common run of a[i..] and b[j..] (a table of (n+1)×(m+1), filled from the end).
    const w = m + 1, L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { mid.push({ op: '=', text: a[i], a: start + i + 1, b: start + j + 1 }); i++; j++; }
      // (on a tie, the removed line comes first)
      else if (j < m && (i >= n || L[i * w + j + 1] > L[(i + 1) * w + j])) { mid.push({ op: '+', text: b[j], a: null, b: start + j + 1 }); j++; }
      else { mid.push({ op: '-', text: a[i], a: start + i + 1, b: null }); i++; }
    }
  }
  out.push(...mid);
  for (let k = 0; k < A.length - endA; k++) out.push({ op: '=', text: A[endA + k], a: endA + k + 1, b: endB + k + 1 });
  return { lines: out, added: out.filter((l) => l.op === '+').length, removed: out.filter((l) => l.op === '-').length, rough };
}

function splitLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines[0] === '' && lines.length === 1 ? [] : lines;
}
