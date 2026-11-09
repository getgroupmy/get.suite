import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { jpegsToPdf } from './scanpdf.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const jpeg = (n) => new Uint8Array(fs.readFileSync(path.join(here, n)));
const pages = [{ jpeg: jpeg('testdata-receipt-portrait.jpg'), width: 400, height: 600 }, { jpeg: jpeg('testdata-receipt-landscape.jpg'), width: 600, height: 300 }];

test('scan to PDF: a page per photo, A4 wide, in proportion; a PDF other programs read', () => {
  const pdf = jpegsToPdf(pages, { title: 'Receipts (March)' });
  const text = Buffer.from(pdf).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  // Every entry in the cross-reference table points at its object.
  const xrefAt = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.ok(text.slice(xrefAt).startsWith('xref'));
  const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => assert.ok(text.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.match(text, /\/MediaBox \[0 0 595\.28 892\.92\]/, 'portrait: 1.5 times as tall');
  assert.match(text, /\/MediaBox \[0 0 595\.28 297\.64\]/, 'landscape: half as tall');
  // A real reader agrees.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nw-scan-')), 'scan.pdf');
  fs.writeFileSync(f, pdf);
  let info;
  try { info = execFileSync('pdfinfo', [f], { encoding: 'utf8' }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  assert.match(info, /Pages:\s+2/);
  assert.match(info, /Title:\s+Receipts \(March\)/);
  assert.doesNotMatch(info, /Syntax Error/);
});

test('scan to PDF: nothing to scan is an error', () => {
  assert.throws(() => jpegsToPdf([]), /No pages/);
});
