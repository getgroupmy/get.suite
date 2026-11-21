// Tabs and runs of spaces in a document's text, through our own .docx and .odt files and back (and through
// LibreOffice): they came back folded into one space (reading the file as HTML folds them; .odt dropped a space starting a
// paragraph). A random test makes 60 documents of headings, lists, checklists (inside lists too), quotes and tables with
// words, marks, links, tabs and double spaces, and each must come back with the same text, marks, ticks and nesting. It
// found a checklist inside a list coming back as "☐ …" lines (.odt) or moved out of the list (.docx), and an item's own
// leading spaces taken with the one after its box.
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
const FORMATS = [['docx', wordFromDoc, docFromWord], ['odt', odtFromDoc, docFromOdt]];
const back = async (to, from, doc) => { const r = await from(await to(doc)); return r.doc || r; };
const texts = (n, out = []) => { if (n.type === 'text') out.push(n.text); for (const c of n.content || []) texts(c, out); return out; };

const SPACED = ['Name:\tAda', '  indented', 'two  spaces', 'tab\tand  spaces  ', 'a\t\tb'];
const spacedDoc = { type: 'doc', content: [
  P(T(SPACED[0])), { type: 'heading', attrs: { level: 2 }, content: [T(SPACED[1])] }, P(T(SPACED[2], [{ type: 'bold' }])),
  { type: 'bulletList', content: [{ type: 'listItem', content: [P(T(SPACED[3]))] }] },
  { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [P(T(SPACED[4]))] }, { type: 'tableCell', content: [P(T('x'))] }] }] },
] };

test('tabs, double spaces and a space starting a paragraph come back from .docx and .odt', async () => {
  for (const [name, to, from] of FORMATS) {
    const got = texts(await back(to, from, spacedDoc)).filter((t) => t !== 'x');
    // (a space ending a paragraph is let go: Word and LibreOffice don't show it either)
    assert.deepEqual(got.map((t) => t.replace(/ +$/, '')), SPACED.map((t) => t.replace(/ +$/, '')), name);
  }
});

test('and through LibreOffice, saved again in either format', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docspacing-'));
  try {
    for (const [name, to, from] of FORMATS) {
      fs.writeFileSync(path.join(dir, `in.${name}`), await to(spacedDoc));
      soffice(['--headless', '--convert-to', name, '--outdir', path.join(dir, 'out'), path.join(dir, `in.${name}`)]);
      const got = texts((await from(fs.readFileSync(path.join(dir, 'out', `in.${name}`)))).doc || {}).filter((t) => t !== 'x');
      assert.deepEqual(got.join('|').replace(/ +(\||$)/g, '$1'), SPACED.map((t) => t.replace(/ +$/, '')).join('|'), name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('60 random documents come back with the same text, marks and nesting', async () => {
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const WORDS = ['alpha', 'Ωmega', 'naïve', 'x<y', 'a&b', '"q"', "it's", '中文', 'שלום', '😀', 'two  spaces', 'tab\there', '1,234', '<tag>', 'ß', '  indented'];
  const MARKS = [[{ type: 'bold' }], [{ type: 'italic' }], [{ type: 'underline' }], [{ type: 'strike' }], [{ type: 'code' }], [{ type: 'subscript' }], [{ type: 'superscript' }], [{ type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }]];
  const text = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => { const t = T((i ? ' ' : '') + pick(WORDS)); if (rnd() < 0.4) t.marks = pick(MARKS); return t; });
  const tasks = () => ({ type: 'taskList', content: Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => ({ type: 'taskItem', attrs: { checked: rnd() < 0.5 }, content: [P(...text())] })) });
  const block = (d) => {
    const r = rnd();
    if (r > 0.92 && d === 0) return tasks();
    if (r < 0.35 || d > 1) return P(...text());
    if (r < 0.45) return { type: 'heading', attrs: { level: 1 + Math.floor(rnd() * 3) }, content: text() };
    if (r < 0.65) return { type: pick(['bulletList', 'orderedList']), content: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ type: 'listItem', content: [P(...text()), ...(rnd() < 0.3 ? [rnd() < 0.5 ? tasks() : { type: 'bulletList', content: [{ type: 'listItem', content: [P(...text())] }] }] : [])] })) };
    if (r < 0.75) return { type: 'blockquote', content: [P(...text())] };
    return { type: 'table', content: Array.from({ length: 2 }, () => ({ type: 'tableRow', content: Array.from({ length: 2 }, () => ({ type: 'tableCell', content: [P(...text())] })) })) };
  };
  // Each block as kind and depth, with its words and their marks (neighbouring words with the same marks run together).
  const flat = (n, depth = 0, out = []) => {
    if (n.type === 'text') { out.push(`${n.text}{${(n.marks || []).map((m) => m.type + (m.attrs?.href ? `:${m.attrs.href}` : '')).sort().join(',')}}`); return out; }
    if (['paragraph', 'heading'].includes(n.type)) out.push(`\n${'>'.repeat(depth)}${n.type}${n.attrs?.level ?? ''}:`);
    if (n.type === 'taskItem') out.push(n.attrs?.checked ? '[x]' : '[ ]');
    for (const c of n.content || []) flat(c, depth + (/List|blockquote|table/.test(n.type) ? 1 : 0), out);
    return out;
  };
  const shape = (d) => flat(d).join('').replace(/\{([^}]*)\}(?=[^\n{]*\{\1\})/g, '');
  const wrong = [];
  for (let k = 0; k < 60; k++) {
    const doc = { type: 'doc', content: Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => block(0)) };
    for (const [name, to, from] of FORMATS) if (shape(await back(to, from, doc)) !== shape(doc)) wrong.push(`${name} #${k}`);
  }
  assert.deepEqual(wrong, []);
});
