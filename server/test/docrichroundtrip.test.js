// A richer document through Word and OpenDocument files, ours and as LibreOffice saves them again: headings, every text
// mark (bold, italic, underline, strikethrough, subscript, superscript, colour, highlight: the editor's textStyle backgroundColor), alignment, nested and numbered
// lists, a checklist, a quote, a code block, a footnote, a page break, a table with a merged heading cell, a line break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { soffice, hasSoffice } from './soffice.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';
import { odtFromDoc, docFromOdt } from '../src/office/odt.js';

const T = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const P = (...c) => ({ type: 'paragraph', content: c });
const LI = (...c) => ({ type: 'listItem', content: c });
const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [T('Title')] },
  { type: 'heading', attrs: { level: 3 }, content: [T('Small heading')] },
  P(T('b', [{ type: 'bold' }]), T(' i', [{ type: 'italic' }]), T(' u', [{ type: 'underline' }]), T(' s', [{ type: 'strike' }]), T(' sub', [{ type: 'subscript' }]), T(' sup', [{ type: 'superscript' }]),
    T(' red', [{ type: 'textStyle', attrs: { color: '#ff0000' } }]), T(' hl', [{ type: 'textStyle', attrs: { backgroundColor: '#ffff00' } }])),
  { type: 'paragraph', attrs: { textAlign: 'center' }, content: [T('Centred')] },
  { type: 'paragraph', attrs: { textAlign: 'right' }, content: [T('Right')] },
  { type: 'bulletList', content: [LI(P(T('One')), { type: 'bulletList', content: [LI(P(T('One a')))] }), LI(P(T('Two')))] },
  { type: 'orderedList', attrs: { start: 1 }, content: [LI(P(T('First'))), LI(P(T('Second')))] },
  { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P(T('Done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [P(T('To do'))] }] },
  { type: 'blockquote', content: [P(T('A quote'))] },
  { type: 'codeBlock', content: [T('let x = 1;\nx++;')] },
  P(T('Note'), { type: 'footnote', attrs: { note: 'The footnote' } }, T(' after.')),
  { type: 'pageBreak' },
  { type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colspan: 2 }, content: [P(T('Both'))] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('a'))] }, { type: 'tableCell', content: [P(T('b'))] }] }] },
  P(T('Line one'), { type: 'hardBreak' }, T('Line two')),
] };
// Attributes left at their defaults (null, 0, rowspan 1…) and column widths aren't compared; nor the order of a node's keys.
const DEFAULTS = { textAlign: null, lineHeight: null, spaceBefore: null, spaceAfter: null, indent: 0, type: null, language: null, rowspan: 1, colspan: 1, align: null, background: null };
const EMPTY_STYLE = new Set(['color', 'backgroundColor', 'fontFamily', 'fontSize']); // (a textStyle's unset parts come back as '')
const clean = (n) => {
  if (Array.isArray(n)) return n.map(clean);
  if (!n || typeof n !== 'object') return n;
  const out = {};
  for (const k of Object.keys(n).sort()) {
    if (k === 'id' || k === 'colwidth') continue;
    if (k === 'attrs') { const a = Object.fromEntries(Object.entries(n.attrs).filter(([ak, av]) => ak !== 'colwidth' && !(ak in DEFAULTS && DEFAULTS[ak] === av) && !(EMPTY_STYLE.has(ak) && av === ''))); if (Object.keys(a).length) out.attrs = clean(a); continue; }
    out[k] = clean(n[k]);
  }
  return out;
};

for (const [ext, write, read] of [['docx', wordFromDoc, docFromWord], ['odt', odtFromDoc, docFromOdt]]) {
  test(`.${ext}: a rich document comes back as it was`, async () => {
    assert.deepEqual(clean((await read(await write(doc))).doc?.content || (await read(await write(doc))).content), clean(doc.content));
  });
  test(`through LibreOffice (.${ext}): saved again by it, the rich document comes back as it was`, { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrich-'));
    fs.writeFileSync(path.join(dir, `in.${ext}`), await write(doc));
    soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', ext, '--outdir', path.join(dir, 'out'), path.join(dir, `in.${ext}`)]);
    const back = await read(fs.readFileSync(path.join(dir, 'out', `in.${ext}`)));
    assert.deepEqual(clean((back.doc || back).content), clean(doc.content));
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
