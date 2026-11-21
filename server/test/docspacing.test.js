// Tabs and runs of spaces in a document's text, through our own .docx and .odt files and back (and through
// LibreOffice): they came back folded into one space (reading the file as HTML folds them; .odt dropped a space starting a
// paragraph). A random test makes 60 documents of headings, lists, checklists (inside lists too), quotes and tables with
// words, marks, links, tabs and double spaces, and each must come back with the same text, marks, ticks and nesting. It
// found a checklist inside a list coming back as "☐ …" lines (.odt) or moved out of the list (.docx), and an item's own
// leading spaces taken with the one after its box. Through LibreOffice, .odt gained an empty paragraph after a table
// that ends the document (the one LibreOffice adds); it's left out now. Through Markdown, underline was lost (it's <u>
// now, as superscript is <sup>), spaces starting a paragraph, item or heading were dropped (written as &#32; now), and two
// pieces of code side by side ran their backticks together. Through RTF, code, checklists, quotes and lists inside lists
// came back as plain paragraphs (code is the fixed-width font now, code blocks and quotes a style of their own, list levels
// their indent or Word's \\ilvl), a list after a table or heading joined the one before it, LibreOffice's way of writing
// runs of spaces doubled them, and bold, italic and code on Hebrew were lost through LibreOffice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { soffice, hasSoffice } from './soffice.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';
import { odtFromDoc, docFromOdt } from '../src/office/odt.js';
import { markdownFromDoc, docFromMarkdown } from '../src/office/markdown.js';
import { rtfFromDoc, docFromRtf } from '../src/office/rtf.js';

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

/** n random documents (the same each run for a seed), and a document's shape to compare: each block's kind and depth, with
 * its words and their marks (neighbouring words with the same marks run together) and ticks. */
function randomDocs(n, start) {
  let seed = start; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
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

  return { docs: Array.from({ length: n }, () => ({ type: 'doc', content: Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => block(0)) })), shape };
}

test('60 random documents come back with the same text, marks and nesting', async () => {
  const { docs, shape } = randomDocs(60, 3);
  const wrong = [];
  for (const [k, doc] of docs.entries()) for (const [name, to, from] of FORMATS) if (shape(await back(to, from, doc)) !== shape(doc)) wrong.push(`${name} #${k}`);
  assert.deepEqual(wrong, []);
});

test('and 25 more through LibreOffice, saved again by it as .docx and as .odt', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const { docs, shape } = randomDocs(25, 5);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docspacing-lo-'));
  const wrong = [];
  try {
    for (const [name, to, from] of FORMATS) {
      fs.mkdirSync(path.join(dir, name, 'out'), { recursive: true });
      const files = [];
      for (const [k, doc] of docs.entries()) { files.push(path.join(dir, name, `d${k}.${name}`)); fs.writeFileSync(files.at(-1), await to(doc)); }
      soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', name, '--outdir', path.join(dir, name, 'out'), ...files]);
      for (const [k, doc] of docs.entries()) {
        const r = await from(fs.readFileSync(path.join(dir, name, 'out', `d${k}.${name}`)));
        if (shape(r.doc || r) !== shape(doc)) wrong.push(`${name} #${k}`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(wrong, []);
});

test('and 60 through Markdown (.md download, a .md file opened): the same, but for marks on spaces at the edge of a word', () => {
  const { docs, shape } = randomDocs(60, 11);
  // (Markdown can't mark a space at the edge of bold or code, ** x**: those spaces come back plain, as they're written)
  const unmarkEdges = (n) => {
    if (n.content) n.content = n.content.flatMap((c) => {
      if (c.type !== 'text' || !c.marks?.length) return [c];
      const [, a, core, z] = /^(\s*)([\s\S]*?)(\s*)$/.exec(c.text);
      return [...(a ? [T(a)] : []), ...(core ? [{ ...c, text: core }] : []), ...(z ? [T(z)] : [])];
    }).map(unmarkEdges);
    return n;
  };
  const same = (d) => shape(unmarkEdges(JSON.parse(JSON.stringify(d))));
  const wrong = docs.flatMap((doc, k) => (same(docFromMarkdown(markdownFromDoc(doc))) === same(doc) ? [] : [`#${k}`]));
  assert.deepEqual(wrong, []);
});

// RTF: the same, comparing words with the same marks side by side as one (RTF has no word boundaries of its own), and a
// heading's words without bold (a heading is bold all through, so bold inside one can't be told apart).
const rtfShape = (shape) => (d) => {
  const merge = (list) => list.reduce((o, c) => { const l = o.at(-1); if (l?.type === 'text' && c.type === 'text' && JSON.stringify(l.marks || []) === JSON.stringify(c.marks || [])) l.text += c.text; else o.push({ ...c }); return o; }, []);
  const tidy = (n, heading = false) => {
    if (!n.content) return n;
    const kids = merge(n.content).flatMap((c) => {
      if (c.type !== 'text') return [tidy(c, c.type === 'heading')];
      const marks = (c.marks || []).filter((m) => !(heading && m.type === 'bold'));
      const [, a, core, z] = /^(\s*)([\s\S]*?)(\s*)$/.exec(c.text);
      return marks.length ? [...(a ? [T(a)] : []), ...(core ? [{ ...c, text: core, marks }] : []), ...(z ? [T(z)] : [])] : [T(c.text)];
    });
    return { ...n, content: merge(kids) };
  };
  return shape(tidy(JSON.parse(JSON.stringify(d))));
};

test('60 through RTF and back: the same', () => {
  const { docs, shape } = randomDocs(60, 13);
  const same = rtfShape(shape);
  const wrong = docs.flatMap((doc, k) => (same(docFromRtf(Buffer.from(rtfFromDoc(doc)))) === same(doc) ? [] : [`#${k}`]));
  assert.deepEqual(wrong, []);
});

test('and 25 through LibreOffice, saved again by it as .rtf', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const { docs, shape } = randomDocs(25, 3);
  // (LibreOffice itself drops strikethrough, subscript and superscript on Hebrew and Arabic words in an .rtf: left out here)
  const plainRtl = (n) => { if (n.type === 'text' && /[\u0590-\u08ff]/.test(n.text) && n.marks) { n.marks = n.marks.filter((m) => !['strike', 'subscript', 'superscript'].includes(m.type)); if (!n.marks.length) delete n.marks; } (n.content || []).forEach(plainRtl); return n; };
  const same = (d) => rtfShape(shape)(plainRtl(JSON.parse(JSON.stringify(d))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docspacing-rtf-'));
  try {
    fs.mkdirSync(path.join(dir, 'out'));
    const files = docs.map((doc, k) => { const f = path.join(dir, `d${k}.rtf`); fs.writeFileSync(f, rtfFromDoc(doc)); return f; });
    soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'rtf', '--outdir', path.join(dir, 'out'), ...files]);
    const wrong = docs.flatMap((doc, k) => (same(docFromRtf(fs.readFileSync(path.join(dir, 'out', `d${k}.rtf`)))) === same(doc) ? [] : [`#${k}`]));
    assert.deepEqual(wrong, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
