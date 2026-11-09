// A document's page setup in the browser: the paper on screen and the printed pages. The same
// sizes as the server's (server/src/pagesetup.js), which also uses them for Word.

export const PAPER = { a4: [210, 297, 'A4'], letter: [215.9, 279.4, 'Letter'], legal: [215.9, 355.6, 'Legal'], a5: [148, 210, 'A5'] }; // mm
export const MARGINS = { normal: [25.4, 'Normal (2.54 cm)'], narrow: [12.7, 'Narrow (1.27 cm)'], wide: [38.1, 'Wide (3.81 cm)'] };
export const DEFAULT_SETUP = { size: 'a4', orientation: 'portrait', margin: 'normal', header: '', footer: '', numbers: false, watermark: '', pageless: false, columns: 1, lineNumbers: false };
/** Text in columns: how many (1 to 3) a setup asks for. */
export const columnsOf = (setup) => (Number.isInteger(setup?.columns) && setup.columns >= 2 && setup.columns <= 3 ? setup.columns : 1);
export const WATERMARKS = ['DRAFT', 'CONFIDENTIAL', 'DO NOT COPY', 'SAMPLE', 'INTERNAL'];

const PX_PER_MM = 96 / 25.4;
const full = (s) => ({ ...DEFAULT_SETUP, ...(s || {}) });

/** Page width and height in mm, turned for landscape. */
export function pageMm(setup) {
  const s = full(setup);
  const [w, h] = PAPER[s.size] || PAPER.a4;
  return s.orientation === 'landscape' ? [h, w] : [w, h];
}

/** The paper on screen: its width, height and margins in pixels, and the watermark on every page's length of it. */
export function paperStyle(setup) {
  if (setup?.pageless) return { maxWidth: 'none', minHeight: 0, padding: '40px clamp(16px, 6vw, 96px)' }; // one long sheet across the window
  const [w, h] = pageMm(setup);
  const m = (MARGINS[full(setup).margin] || MARGINS.normal)[0];
  const mark = full(setup).watermark;
  return {
    maxWidth: Math.round(w * PX_PER_MM), minHeight: Math.round(h * PX_PER_MM), padding: `${Math.round(m * PX_PER_MM)}px`,
    ...(mark && { backgroundImage: `url("${watermarkSvg(mark, w, h)}")`, backgroundSize: `100% ${Math.round(h * PX_PER_MM)}px`, backgroundRepeat: 'repeat-y' }),
  };
}

const xml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A page-sized picture of the watermark: faint grey text across the middle, at 45°. */
export function watermarkSvg(text, w = 210, h = 297) {
  const size = Math.min(Math.hypot(w, h) * 0.8 / Math.max(4, text.length * 0.62), w * 0.35); // fill most of the diagonal
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><text x="${w / 2}" y="${h / 2}" transform="rotate(-${(Math.atan2(h, w) * 180 / Math.PI).toFixed(1)} ${w / 2} ${h / 2})" text-anchor="middle" dominant-baseline="middle" font-family="Calibri, Arial, sans-serif" font-weight="700" font-size="${size.toFixed(1)}" fill="#9aa0a6" fill-opacity="0.28">${xml(text)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const cssText = (t) => `"${String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r]/g, ' ')}"`;

/** The printed pages: @page with the size, margins, header, footer and page numbers. */
export function printCss(setup) {
  const s = full(setup);
  const [w, h] = pageMm(s);
  const m = (MARGINS[s.margin] || MARGINS.normal)[0];
  const box = (content) => `content: ${content}; font: 9pt system-ui, sans-serif; color: #666;`;
  const footer = [s.footer && cssText(s.footer), s.numbers && `${s.footer ? '"   " ' : ''}counter(page) " of " counter(pages)`].filter(Boolean).join(' ');
  // The watermark: one fixed picture, which the browser repeats on every printed page.
  const mark = s.watermark ? ` .paper { background: none !important; } .print-watermark { display: block !important; position: fixed; inset: 0; z-index: 0; pointer-events: none; background: url("${watermarkSvg(s.watermark, w - 2 * m, h - 2 * m)}") center / 100% 100% no-repeat; -webkit-print-color-adjust: exact; print-color-adjust: exact; }` : '';
  return `@media print { @page { size: ${w}mm ${h}mm; margin: ${m}mm;${s.header ? ` @top-center { ${box(cssText(s.header))} }` : ''}${footer ? ` @bottom-center { ${box(footer)} }` : ''} }${mark} }`;
}
