// Which lines of a version comparison to show: the changes with a few lines around them, other unchanged runs folded.

const CONTEXT = 3;

/** The lines to show: changes with CONTEXT lines around them; other unchanged runs as { fold: [from, to] }. */
export function foldLines(lines, open = new Set()) {
  const near = new Array(lines.length).fill(false);
  lines.forEach((l, i) => { if (l.op !== '=') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) near[k] = true; });
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (near[i] || lines[i].op !== '=') { out.push(lines[i]); i++; continue; }
    let j = i;
    while (j < lines.length && !near[j]) j++;
    if (open.has(i) || j - i <= 2) out.push(...lines.slice(i, j));
    else out.push({ fold: [i, j] });
    i = j;
  }
  return out;
}
