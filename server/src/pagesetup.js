// A document's page setup: paper size, orientation, margins, and a header and footer (with page
// numbers) for printing and Word. Kept with the file as JSON; anything missing takes the default.
import { bad } from './util.js';

export const PAPER = { a4: [210, 297], letter: [215.9, 279.4], legal: [215.9, 355.6], a5: [148, 210] }; // mm
export const MARGINS = { normal: 25.4, narrow: 12.7, wide: 38.1 }; // mm, all four sides
export const DEFAULT_SETUP = { size: 'a4', orientation: 'portrait', margin: 'normal', header: '', footer: '', numbers: false, watermark: '' };
export const MAX_WATERMARK = 40;

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
  return { size: s.size, orientation: s.orientation, margin: s.margin, header: text(s.header, 'Header'), footer: text(s.footer, 'Footer'), numbers: !!s.numbers, watermark };
}

/** Page width and height (mm) for a setup, turned for landscape. */
export function pageMm(setup) {
  const [w, h] = PAPER[setup?.size] || PAPER.a4;
  return setup?.orientation === 'landscape' ? [h, w] : [w, h];
}
