// A document's page setup: paper size, orientation, margins, a header and footer (with page
// numbers), text in columns and line numbers, for printing and Word. Kept with the file as JSON; anything missing takes the default.
import { bad } from './util.js';

export const PAPER = { a4: [210, 297], letter: [215.9, 279.4], legal: [215.9, 355.6], a5: [148, 210] }; // mm
export const MARGINS = { normal: 25.4, narrow: 12.7, wide: 38.1 }; // mm, all four sides
export const DEFAULT_SETUP = { size: 'a4', orientation: 'portrait', margin: 'normal', header: '', footer: '', numbers: false, watermark: '' };
export const MAX_WATERMARK = 40;
export const MAX_COLUMNS = 3;

/** A clean page setup from what was sent (unknown values refused). */
export function readSetup(v) {
  if (v === null) return null;
  if (typeof v !== 'object') throw bad('Bad page setup');
  const s = { ...DEFAULT_SETUP, ...v };
  if (!PAPER[s.size]) throw bad('Unknown paper size');
  if (!['portrait', 'landscape'].includes(s.orientation)) throw bad('Portrait or landscape');
  if (!MARGINS[s.margin]) throw bad('Unknown margins');
  const text = (t, name) => { if (typeof t !== 'string') throw bad(`${name} must be text`); if (t.length > 200) throw bad(`${name} is too long`); return t.replace(/[\r\n]+/g, ' ').trim(); };
  const watermark = text(s.watermark ?? '', 'Watermark');
  if (watermark.length > MAX_WATERMARK) throw bad(`A watermark can be ${MAX_WATERMARK} characters at most`);
  const columns = s.columns ?? 1;
  if (!Number.isInteger(columns) || columns < 1 || columns > MAX_COLUMNS) throw bad(`Columns: 1 to ${MAX_COLUMNS}`);
  // pageless: on screen the document is one long sheet as wide as the window (printing and Word still use the paper).
  return { size: s.size, orientation: s.orientation, margin: s.margin, header: text(s.header, 'Header'), footer: text(s.footer, 'Footer'), numbers: !!s.numbers, watermark, ...(columns > 1 && { columns }), ...(s.lineNumbers === true && { lineNumbers: true }), ...(s.pageless === true && { pageless: true }), ...(s.headingNumbers === true && { headingNumbers: true }) };
}

/** Page width and height (mm) for a setup, turned for landscape. */
export function pageMm(setup) {
  const [w, h] = PAPER[setup?.size] || PAPER.a4;
  return setup?.orientation === 'landscape' ? [h, w] : [w, h];
}

/**
 * Numbered headings (1, 1.1, 1.1.1): the label of each heading, in order, from their levels. Levels 1 to 3
 * are numbered (a heading below another level's goes under it; before any, that level counts as 0), deeper
 * ones aren't (null). The same as the editor's numbering on screen.
 */
export function headingLabels(levels) {
  const n = [0, 0, 0, 0];
  return levels.map((lv) => {
    if (!(lv >= 1 && lv <= 3)) return null;
    n[lv] += 1;
    for (let k = lv + 1; k <= 3; k++) n[k] = 0;
    return n.slice(1, lv + 1).join('.');
  });
}

/** The document with its headings' numbers written in (for downloads that have no numbering of their own: OpenDocument, Markdown, e-book). */
export function withHeadingNumbers(doc) {
  const levels = [];
  (function walk(n) { if (n?.type === 'heading') levels.push(n.attrs?.level || 1); else for (const c of n?.content || []) walk(c); })(doc);
  const labels = headingLabels(levels);
  let k = 0;
  const map = (n) => {
    if (n?.type === 'heading') { const label = labels[k++]; return label ? { ...n, content: [{ type: 'text', text: `${label} ` }, ...(n.content || [])] } : n; }
    return n?.content ? { ...n, content: n.content.map(map) } : n;
  };
  return map(doc);
}
