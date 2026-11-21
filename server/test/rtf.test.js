import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rtfFromDoc, docFromRtf } from '../src/office/rtf.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { soffice, hasSoffice } from './soffice.js';

const T = (text, ...m) => ({ type: 'text', text, ...(m.length && { marks: m.map((x) => (typeof x === 'string' ? { type: x } : x)) }) });
const P = (...c) => ({ type: 'paragraph', content: c });
const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 1 }, content: [T('Plan for 2027')] },
  P(T('Bold', 'bold'), T(' italic', 'italic'), T(' under', 'underline'), T(' café € “quote” 日本 😀', 'strike'), T(' H'), T('2', 'subscript'), T('O x'), T('2', 'superscript')),
  { type: 'paragraph', attrs: { textAlign: 'center' }, content: [T('Centred'), { type: 'hardBreak' }, T('second line')] },
  P(T('See '), T('the site', { type: 'link', attrs: { href: 'https://acme.example/a?b=1' } }), T(' {braces} \\ back'), { type: 'math', attrs: { latex: 'x^2' } }),
  { type: 'heading', attrs: { level: 2 }, content: [T('Steps')] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [P(T('One'))] }, { type: 'listItem', content: [P(T('Two'))] }] },
  { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [P(T('Third'))] }, { type: 'listItem', content: [P(T('Fourth'))] }] },
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [P(T('Item'))] }, { type: 'tableHeader', content: [P(T('Cost'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [P(T('Taxi'))] }, { type: 'tableCell', content: [P(T('12'))] }] }] },
  P(T('After the table.')),
] };
const show = (d) => d.content.map((n) => `${n.type}${n.attrs?.level || ''}${n.attrs?.textAlign ? `[${n.attrs.textAlign}]` : ''}${n.attrs?.start > 1 ? `@${n.attrs.start}` : ''}: ${(function t(x) { return x.type === 'text' ? x.text + (x.marks ? `{${x.marks.map((m) => m.type + (m.attrs?.href ? `=${m.attrs.href}` : '')).join(',')}}` : '') : x.type === 'hardBreak' ? '⏎' : (x.content || []).map(t).join(x.type === 'tableRow' ? ' | ' : x.type === 'table' || x.type.endsWith('List') ? ' / ' : ''); })(n)}`);
const want = [
  'heading1: Plan for 2027',
  'paragraph: Bold{bold} italic{italic} under{underline} café € “quote” 日本 😀{strike} H2{subscript}O x2{superscript}',
  'paragraph[center]: Centred⏎second line',
  'paragraph: See the site{link=https://acme.example/a?b=1} {braces} \\ backx^2',
  'heading2: Steps',
  'bulletList: One / Two',
  'orderedList@3: Third / Fourth',
  'table: Item{bold} | Cost{bold} / Taxi | 12',
  'paragraph: After the table.',
];

test('RTF: a document goes out as Rich Text (7-bit, others as \\u) and comes back as it was', () => {
  const rtf = rtfFromDoc(doc);
  assert.match(rtf, /^\{\\rtf1\\ansi/);
  assert.equal(/[^\x00-\x7f]/.test(rtf), false, 'all 7-bit');
  assert.match(rtf, /caf\\u233\\'3f/); // (the stand-in ? as \'3f, as Word writes it: a plain ? reads as the end of \u… to some)
  assert.match(rtf, /\\u-10179\\'3f\\u-8704\\'3f/, 'an emoji as its two halves');
  assert.match(rtf, /\{\\field\{\\\*\\fldinst\{HYPERLINK "https:\/\/acme.example\/a\?b=1"\}\}/);
  assert.match(rtf, /\\outlinelevel0/);
  assert.deepEqual(show(docFromRtf(Buffer.from(rtf, 'latin1'))), want);
});

test('RTF in: what Word and others write (code pages, \\u with fallbacks, heading styles, list labels, fields)', () => {
  const rtf = String.raw`{\rtf1\ansi\ansicpg1252\uc1{\fonttbl{\f0 Calibri;}}{\stylesheet{\s0 Normal;}{\s1\b\fs32 heading 1;}{\s2\sbasedon0 Heading 2;}}{\info{\title Secret title}}
{\pard\plain\s1 Intro\par}
{\pard Caf\'e9 \'93ok\'94 ${'\\'}u8364\'80 and\~more\par}
{\pard{\listtext\pard\plain ${'\\'}u8226\'95\tab}\ls1 Apples\par}
{\pard{\listtext\pard\plain 1.\tab}\ls2 Pears\par}
{\pard\s2 Next\par}
{\*\generator Word;}{\pard\qr Right {\b bold\b0  plain}\line two\par}}`;
  assert.deepEqual(show(docFromRtf(Buffer.from(rtf, 'latin1'))), ['heading1: Intro', 'paragraph: Café “ok” € and more', 'bulletList: Apples', 'orderedList: Pears', 'heading2: Next', 'paragraph[right]: Right bold{bold} plain⏎two']);
  assert.throws(() => docFromRtf(Buffer.from('not rtf')), /Not an RTF file/);
});

test('RTF: LibreOffice reads ours, and its own comes in (headings, lists, links, tables)', async (t) => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { t.diagnostic('LibreOffice not installed: skipped'); return; }
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { docFromOdt } = await import('../src/office/odt.js');
  const { wordFromDoc } = await import('../src/office/word.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtf-'));
  const lo = (f, as, out) => { execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, out), path.join(dir, f)], { stdio: 'ignore', timeout: 120000 }); return fs.readFileSync(path.join(dir, out, f.replace(/\.\w+$/, `.${as}`))); };
  fs.writeFileSync(path.join(dir, 'a.rtf'), rtfFromDoc(doc), 'latin1');
  // (LibreOffice gives every run a font: what Docs keeps as textStyle, left out here)
  const plain = (n) => ({ ...n, ...(n.marks && { marks: n.marks.filter((m) => m.type !== 'textStyle') }), ...(n.content && { content: n.content.map(plain) }) });
  const unmark = (n) => (n.marks && !n.marks.length ? (({ marks, ...rest }) => rest)(n) : { ...n, ...(n.content && { content: n.content.map(unmark) }) });
  const lod = show(unmark(plain((await docFromOdt(lo('a.rtf', 'odt', 'o'))).doc)));
  assert.equal(lod[0], 'heading1: Plan for 2027');
  assert.equal(lod[2], 'paragraph[center]: Centred⏎second line');
  assert.match(lod.find((l) => l.includes('the site')), /the site\{link=https:\/\/acme.example\/a\?b=1/);
  assert.ok(lod.some((l) => /^table: Item\{bold\} \| Cost\{bold\} \/ Taxi \| 12$/.test(l)), lod.join('\n'));
  fs.writeFileSync(path.join(dir, 'w.docx'), await wordFromDoc(doc, 'T'));
  const back = show(docFromRtf(lo('w.docx', 'rtf', 'r'))).filter((l) => l !== 'paragraph: ');
  // (the equation goes to Word as a Word equation, which LibreOffice without its Math part leaves out)
  assert.deepEqual(back.slice(0, 5), want.slice(0, 5).map((l) => l.replace('backx^2', 'back')));
  assert.deepEqual(back.slice(5, 8), ['bulletList: One / Two', 'orderedList@3: Third / Fourth', 'table: Item | Cost / Taxi | 12']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('RTF lists are Word\'s own lists, and footnotes its footnotes: through LibreOffice and back', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const P = (x) => ({ type: 'paragraph', content: [{ type: 'text', text: x }] });
  const doc = { type: 'doc', content: [
    { type: 'bulletList', content: [{ type: 'listItem', content: [P('one'), { type: 'orderedList', content: [{ type: 'listItem', content: [P('nested')] }] }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [P('done')] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Note here' }, { type: 'footnote', attrs: { note: 'The note.' } }] },
  ] };
  const rtf = rtfFromDoc(doc);
  assert.match(rtf, /\{\\\*\\listtable/, 'a list table');
  assert.match(rtf, /\\ls1\\ilvl0[^{]*\{\\listtext/, 'items of a list, with their label');
  assert.match(rtf, /\{\\footnote\\pard\\plain\{\\super\\chftn\} The note\.\}/, 'a footnote');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtflists-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.rtf'), rtf);
    soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'rtf', '--outdir', path.join(dir, 'out'), path.join(dir, 'a.rtf')]);
    const back = docFromRtf(fs.readFileSync(path.join(dir, 'out', 'a.rtf')));
    const types = (n) => [n.type, ...(n.content || []).flatMap(types)].filter((t) => !['text', 'paragraph', 'doc'].includes(t));
    assert.deepEqual(types(back), ['bulletList', 'listItem', 'orderedList', 'listItem', 'taskList', 'taskItem', 'footnote']);
    assert.equal(back.content[2].content.find((n) => n.type === 'footnote').attrs.note, 'The note.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
