import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageMm, paperStyle, printCss } from './pagesetup.js';

test('paper sizes and orientation', () => {
  assert.deepEqual(pageMm(null), [210, 297]);
  assert.deepEqual(pageMm({ size: 'letter', orientation: 'landscape' }), [279.4, 215.9]);
  assert.deepEqual(paperStyle(null), { maxWidth: 794, minHeight: 1123, padding: '96px' });
  assert.equal(paperStyle({ margin: 'narrow' }).padding, '48px');
});

test('printed pages: size, margins, header, footer and page numbers', () => {
  assert.equal(printCss(null), '@media print { @page { size: 210mm 297mm; margin: 25.4mm; } }');
  const css = printCss({ size: 'a5', orientation: 'landscape', margin: 'wide', header: 'Acme "Trading"', footer: 'Confidential', numbers: true });
  assert.match(css, /size: 210mm 148mm; margin: 38.1mm;/);
  assert.match(css, /@top-center \{ content: "Acme \\"Trading\\""/);
  assert.match(css, /@bottom-center \{ content: "Confidential" "   " counter\(page\) " of " counter\(pages\)/);
  assert.match(printCss({ numbers: true }), /@bottom-center \{ content: counter\(page\) " of " counter\(pages\)/);
});

import { watermarkSvg, paperStyle as paperStyleW, printCss as printCssW } from './pagesetup.js';
test('watermark: a faint diagonal picture on every page on screen and when printed', () => {
  const svg = decodeURIComponent(watermarkSvg('R&D <draft>', 210, 297).split(',')[1]);
  assert.match(svg, /<text [^>]*rotate\(-54\.7 105 148\.5\)[^>]*>R&amp;D &lt;draft&gt;<\/text>/);
  const st = paperStyleW({ watermark: 'DRAFT' });
  assert.match(st.backgroundImage, /^url\("data:image\/svg\+xml,/);
  assert.equal(st.backgroundSize, '100% 1123px', 'one per A4 page length');
  assert.equal(paperStyleW({}).backgroundImage, undefined);
  assert.match(printCssW({ watermark: 'DRAFT' }), /\.print-watermark \{ display: block !important; position: fixed;/);
  assert.doesNotMatch(printCssW({}), /print-watermark/);
});
