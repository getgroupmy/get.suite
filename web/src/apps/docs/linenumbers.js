// Line numbers (Docs, Page setup → Line numbers): every line of text numbered down the left margin,
// as lawyers and reviewers use them ("see line 42"). Lines are measured as the browser lays them out,
// so a paragraph that wraps onto three lines gets three numbers; tables aren't numbered (as in Word).

/**
 * The lines among a block's line boxes (in reading order): boxes on the same line merge; a box
 * below the last one, or back up at the top (the next column), starts a new line.
 * rects: [{ top, bottom, left }] → [{ top, bottom, left }].
 */
export function groupLines(rects) {
  const lines = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    const sameLine = last && r.top < last.bottom - 1 && r.bottom > last.top + 1 && r.left >= last.left - 1;
    if (sameLine) { last.top = Math.min(last.top, r.top); last.bottom = Math.max(last.bottom, r.bottom); }
    else lines.push({ top: r.top, bottom: r.bottom, left: r.left });
  }
  return lines;
}

/** The left edge of the column a point at `x` is in (the text is in `cols` columns `gap` apart). */
export function columnLeft(x, left, width, cols = 1, gap = 0) {
  if (cols <= 1) return left;
  const w = (width - gap * (cols - 1)) / cols;
  const i = Math.max(0, Math.min(cols - 1, Math.floor((x - left + gap / 2) / (w + gap))));
  return left + i * (w + gap);
}

// The blocks whose lines count: paragraphs (in lists and quotes too), headings and code; not tables.
const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, pre';
const SKIP = '.collaboration-carets__caret, .collaboration-carets__label';
const ATOMS = 'img, .doc-math, .doc-date, .doc-chip, .doc-mention';

/**
 * Each line of the document's text, numbered: [{ n, top, left }] in pixels from `box` (the paper),
 * `left` being the left edge of the line's column.
 */
export function measureLines(root, box) {
  const at = box.getBoundingClientRect();
  const pm = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const cols = Number(style.columnCount) || 1;
  const gap = parseFloat(style.columnGap) || 0;
  const padL = parseFloat(style.paddingLeft) || 0;
  const padR = parseFloat(style.paddingRight) || 0;
  const out = [];
  const range = document.createRange();
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (el.closest('table, .footnotes') || el.parentElement?.closest('pre')) continue;
    // Only the text and inline pictures, chips and equations, in document order: not others' cursors and their name labels.
    const rects = [];
    const collect = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) { if (c.data) { range.selectNodeContents(c); rects.push(...[...range.getClientRects()].filter((r) => r.height > 0)); } }
        else if (c.nodeType === 1 && !c.matches(SKIP)) { if (c.matches(ATOMS)) rects.push(c.getBoundingClientRect()); else collect(c); }
      }
    };
    collect(el);
    if (!rects.length) { const r = el.getBoundingClientRect(); if (r.height > 0) rects.push(r); } // an empty line
    for (const line of groupLines(rects.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left })))) {
      out.push({ n: out.length + 1, top: Math.round(line.top - at.top), height: Math.round(line.bottom - line.top),
        left: Math.round(columnLeft(line.left, pm.left + padL, pm.width - padL - padR, cols, gap) - at.left) });
    }
  }
  return out;
}
