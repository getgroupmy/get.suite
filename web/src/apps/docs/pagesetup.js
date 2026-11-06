// A document's page setup in the browser: the paper on screen and the printed pages. The same
// sizes as the server's (server/src/pagesetup.js), which also uses them for Word.

export const PAPER = { a4: [210, 297, 'A4'], letter: [215.9, 279.4, 'Letter'], legal: [215.9, 355.6, 'Legal'], a5: [148, 210, 'A5'] }; // mm
export const MARGINS = { normal: [25.4, 'Normal (2.54 cm)'], narrow: [12.7, 'Narrow (1.27 cm)'], wide: [38.1, 'Wide (3.81 cm)'] };
export const DEFAULT_SETUP = { size: 'a4', orientation: 'portrait', margin: 'normal', header: '', footer: '', numbers: false };

const PX_PER_MM = 96 / 25.4;
const full = (s) => ({ ...DEFAULT_SETUP, ...(s || {}) });

/** Page width and height in mm, turned for landscape. */
export function pageMm(setup) {
  const s = full(setup);
  const [w, h] = PAPER[s.size] || PAPER.a4;
  return s.orientation === 'landscape' ? [h, w] : [w, h];
}

/** The paper on screen: its width, height and margins in pixels. */
export function paperStyle(setup) {
  const [w, h] = pageMm(setup);
  const m = (MARGINS[full(setup).margin] || MARGINS.normal)[0];
  return { maxWidth: Math.round(w * PX_PER_MM), minHeight: Math.round(h * PX_PER_MM), padding: `${Math.round(m * PX_PER_MM)}px` };
}

const cssText = (t) => `"${String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]/g, ' ')}"`;

/** The printed pages: @page with the size, margins, header, footer and page numbers. */
export function printCss(setup) {
  const s = full(setup);
  const [w, h] = pageMm(s);
  const m = (MARGINS[s.margin] || MARGINS.normal)[0];
  const box = (content) => `content: ${content}; font: 9pt system-ui, sans-serif; color: #666;`;
  const footer = [s.footer && cssText(s.footer), s.numbers && `${s.footer ? '"   " ' : ''}counter(page) " of " counter(pages)`].filter(Boolean).join(' ');
  return `@media print { @page { size: ${w}mm ${h}mm; margin: ${m}mm;${s.header ? ` @top-center { ${box(cssText(s.header))} }` : ''}${footer ? ` @bottom-center { ${box(footer)} }` : ''} } }`;
}
