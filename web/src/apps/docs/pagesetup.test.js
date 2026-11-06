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
