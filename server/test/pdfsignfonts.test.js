// Signed PDFs with signers' names beyond Western European letters: the Signatures page and the typed signatures in
// their boxes show the names as written (from fonts installed on the server), not "???", wherever a font has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { withSignaturesPage, fillFields } from '../src/pdftools.js';
import { installedCovers } from '../src/office/pdffonts.js';

const hasPoppler = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0;
const NAMES = ['陈美玲', 'Αλέξης Παπαδόπουλος', 'முருகன்', 'Ольга Петрова'].filter((n) => installedCovers(n));
const blank = async () => { const d = await PDFDocument.create(); d.addPage([595, 842]); return d.save(); };
const flat = (s) => s.replace(/\s+/g, '');

test('the Signatures page and typed signatures show the signers\' names as written', { skip: (!hasPoppler && 'poppler isn’t installed here') || (!NAMES.length && 'no fonts for them here') }, async () => {
  const at = Date.UTC(2026, 10, 20, 9);
  const signers = NAMES.map((name, i) => ({ name, email: `s${i}@example.com`, signed_at: at }));
  const withPage = await withSignaturesPage(await blank(), { title: 'Contract 合同', hash: 'ab'.repeat(32), signers });
  const text = flat(execFileSync('pdftotext', ['-', '-'], { input: Buffer.from(withPage) }).toString());
  for (const n of NAMES) assert.ok(text.includes(flat(n)), `the Signatures page has “${n}”`);
  assert.ok(!/\?\?\?/.test(text));
  const fields = NAMES.map((n, i) => ({ email: `s${i}@example.com`, page: 0, x: 0.1, y: 0.1 + i * 0.12, w: 0.6, h: 0.06, type: 'signature' }));
  const filled = await fillFields(await blank(), fields, Object.fromEntries(signers.map((s) => [s.email, s])));
  const t2 = flat(execFileSync('pdftotext', ['-', '-'], { input: Buffer.from(filled) }).toString());
  for (const n of NAMES) assert.ok(t2.includes(flat(n)), `the typed signature “${n}” is in its box`);
});
