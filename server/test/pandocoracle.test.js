// Documents against another converter: pandoc. Random documents (headings, paragraphs, lists inside lists, quotes;
// bold, italic, underline, strikethrough, code, subscript, superscript, links; accents, Hebrew, Chinese, emoji and the
// characters Markdown uses) go out as Markdown, .docx and .odt and pandoc reads each; and pandoc turns our Markdown
// into .docx and .odt that Docs opens. Every way, the same blocks, nesting, words and each word's look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { markdownFromDoc, docFromMarkdown } from '../src/office/markdown.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';
import { odtFromDoc, docFromOdt } from '../src/office/odt.js';

const hasPandoc = spawnSync('pandoc', ['--version']).status === 0;
const pandoc = (args, input) => { const r = spawnSync('pandoc', args, { input, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(String(r.stderr)); return r.stdout; };

const BASE = Number(process.env.SEED) || 20261121;
let seed = BASE;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['alpha', 'Ωmega', 'naïve', 'x<y', 'a&b', '"q"', "it's", '中文', 'שלום', '😀', '1,234', '<tag>', 'ß', '*star*', '_under_', '#hash', '[br]', 'back\\slash', '`tick`', 'a|b', '~tilde~', '50%', '1.', '-', '+', '>'];
const LINK = { type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } };
const MARKS = [['bold'], ['italic'], ['bold', 'italic'], ['underline'], ['strike'], ['code'], ['subscript'], ['superscript'], [LINK], ['bold', LINK]];
const T = (text, marks) => ({ type: 'text', text, ...(marks && { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) }) });
// Words one space apart, each with one look (Markdown has no way to keep a run of spaces, nor a look on a space alone).
const words = () => {
  const out = [];
  for (let i = 0, n = 1 + Math.floor(rnd() * 5); i < n; i++) {
    const w = pick(WORDS);
    const marks = rnd() < 0.4 ? pick(MARKS) : null;
    if (i) out.push(T(' '));
    out.push(T(marks?.includes('code') ? w.replace(/`/g, "'") : /^[-+>]$|^1\.$/.test(w) && !i ? `x${w}` : w, marks)); // (a line starting "- " or "1. " is a list in Markdown)
  }
  return out;
};
const P = () => ({ type: 'paragraph', content: words() });
function block(depth = 0) {
  const r = rnd();
  if (r < 0.4 || depth > 1) return P();
  if (r < 0.55) return { type: 'heading', attrs: { level: 1 + Math.floor(rnd() * 3) }, content: words() };
  if (r < 0.62 && !depth) return { type: 'taskList', content: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ type: 'taskItem', attrs: { checked: rnd() < 0.5 }, content: [P()] })) };
  if (r < 0.85) return { type: pick(['bulletList', 'orderedList']), content: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ type: 'listItem', content: [P(), ...(rnd() < 0.3 ? [{ type: pick(['bulletList', 'orderedList']), content: [{ type: 'listItem', content: [P()] }] }] : [])] })) };
  if (r < 0.92 || depth) return { type: 'blockquote', content: [P(), ...(rnd() < 0.3 ? [P()] : [])] };
  if (r < 0.96) return { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => words().map((t) => t.text).join('')).join('\n') }] };
  const cols = 2 + Math.floor(rnd() * 2);
  return { type: 'table', content: Array.from({ length: 2 + Math.floor(rnd() * 2) }, (_, r) => ({ type: 'tableRow', content: Array.from({ length: cols }, () => ({ type: r ? 'tableCell' : 'tableHeader', content: [P()] })) })) };
}
// (two code blocks one after the other are one in a Word file, as anyone reads it: joined here too)
const joinCode = (list) => list.reduce((out, b) => { const last = out[out.length - 1]; if (b.type === 'codeBlock' && last?.type === 'codeBlock') last.content[0].text += `\n${b.content[0].text}`; else out.push(b); return out; }, []);
const randomDocs = (n, start) => (seed = BASE + start, Array.from({ length: n }, () => ({ type: 'doc', content: joinCode(Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => block())) })));

// ---- a document as lines to compare: "• • h2: word{bold} word{}" (nesting, kind, each word with its look) ----
const markName = (m) => (m.type === 'link' ? `link:${m.attrs.href}` : m.type);
function ourShape(doc) {
  const lines = [];
  const walk = (n, path, tick = null) => {
    if (n.type === 'taskItem') { (n.content || []).forEach((c, k) => walk(c, path, k ? null : n.attrs?.checked ? '☒' : '☐')); return; } // (as pandoc has a checklist: bullets starting ☐ or ☒)
    if (n.type === 'paragraph' || n.type === 'heading') {
      const ws = tick ? [`${tick}{}`] : [];
      for (const t of n.content || []) for (const part of String(t.text || '').split(/(\s+)/)) if (part && !/^\s+$/.test(part)) ws.push(`${part}{${(t.marks || []).map(markName).sort().join(',')}}`);
      lines.push(`${path.join('')}${n.type === 'heading' ? `h${n.attrs.level}` : 'p'}: ${ws.join(' ')}`);
      return;
    }
    if (n.type === 'codeBlock') { lines.push(`${path.join('')}code: ${(n.content || []).map((c) => c.text).join('')}`); return; }
    const mark = { bulletList: '•', taskList: '•', orderedList: '#', blockquote: '>', table: 'T' }[n.type];
    for (const c of n.content || []) walk(c, mark ? [...path, mark] : path);
  };
  walk(doc.doc || doc, []);
  return lines;
}
/** The same from pandoc's own reading (its JSON), raw <u>/<sub>/<sup> tags (Markdown's way to write them) as looks. */
function pandocShape(ast) {
  const lines = [];
  const inl = (list, marks, ws, raw) => {
    for (const i of list) {
      const m = (k) => [...marks, k];
      switch (i.t) {
        case 'Str': { const key = [...marks, ...raw].sort().join(','); const last = ws[ws.length - 1]; if (last && !last.spaced && last.key === key) last.text += i.c; else if (last && !last.spaced) { last.text += i.c; last.mixed = true; } else ws.push({ text: i.c, key }); break; }
        case 'Space': case 'SoftBreak': case 'LineBreak': if (ws.length) ws[ws.length - 1].spaced = true; break;
        case 'Strong': inl(i.c, m('bold'), ws, raw); break;
        case 'Emph': inl(i.c, m('italic'), ws, raw); break;
        case 'Underline': inl(i.c, m('underline'), ws, raw); break;
        case 'Strikeout': inl(i.c, m('strike'), ws, raw); break;
        case 'Subscript': inl(i.c, m('subscript'), ws, raw); break;
        case 'Superscript': inl(i.c, m('superscript'), ws, raw); break;
        case 'Code': inl(i.c[1].split(/( )/).map((p) => (p === ' ' ? { t: 'Space' } : { t: 'Str', c: p })).filter((p) => p.c !== ''), m('code'), ws, raw); break;
        case 'Link': inl(i.c[1], m(`link:${i.c[2][0]}`), ws, raw); break;
        case 'Span': inl(i.c[1], marks, ws, raw); break;
        case 'RawInline': { const tag = /^<(\/?)(u|sub|sup|s|del|strike)>$/.exec(i.c[1]); if (tag) { const name = { u: 'underline', sub: 'subscript', sup: 'superscript', s: 'strike', del: 'strike', strike: 'strike' }[tag[2]]; if (tag[1]) raw.splice(raw.indexOf(name), 1); else raw.push(name); } else inl([{ t: 'Str', c: i.c[1] }], marks, ws, raw); break; }
        default: inl([{ t: 'Str', c: `?${i.t}` }], marks, ws, raw);
      }
    }
    return ws;
  };
  const words = (list) => inl(list, [], [], []).map((w) => `${w.text}{${w.mixed ? '?' : w.key}}`).join(' ');
  const walk = (b, path) => {
    switch (b.t) {
      case 'Para': case 'Plain': lines.push(`${path.join('')}p: ${words(b.c)}`); break;
      case 'Header': lines.push(`${path.join('')}h${b.c[0]}: ${words(b.c[2])}`); break;
      case 'BulletList': for (const item of b.c) for (const c of item) walk(c, [...path, '•']); break;
      case 'OrderedList': for (const item of b.c[1]) for (const c of item) walk(c, [...path, '#']); break;
      case 'BlockQuote': for (const c of b.c) walk(c, [...path, '>']); break;
      case 'Div': for (const c of b.c[1]) walk(c, path); break;
      case 'RawBlock': if (!/^<!--[\s\S]*-->\s*$/.test(b.c[1])) lines.push(`${path.join('')}?RawBlock`); break; // (an HTML comment: nothing)
      case 'CodeBlock': lines.push(`${path.join('')}code: ${b.c[1].replace(/\n$/, '')}`); break;
      case 'Table': { // [attr, caption, colspecs, head [attr, rows], bodies [[attr, n, head rows, rows]], foot]: each cell's blocks, row by row
        const rows = [...b.c[3][1], ...b.c[4].flatMap((body) => [...body[2], ...body[3]]), ...b.c[5][1]];
        for (const row of rows) for (const cell of row[1]) { if (!cell[4].length) lines.push(`${path.join('')}Tp: `); for (const c of cell[4]) walk(c, [...path, 'T']); }
        break;
      }
      default: lines.push(`${path.join('')}?${b.t}`);
    }
  };
  for (const b of ast.blocks) walk(b, []);
  return lines;
}
const read = (from, buf) => pandocShape(JSON.parse(pandoc(['-f', from, '-t', 'json'], buf)));

test('60 random documents, read by pandoc from our Markdown, .docx and .odt: the same', { skip: !hasPandoc && 'pandoc isn’t installed here' }, async () => {
  for (const [i, doc] of randomDocs(60, 1).entries()) {
    const want = ourShape(doc);
    assert.deepEqual(read('gfm', markdownFromDoc(doc)), want, `document ${i}, Markdown:\n${markdownFromDoc(doc)}`);
    assert.deepEqual(read('docx', await wordFromDoc(doc, 'T')), want, `document ${i}, .docx`);
    // (pandoc reads underline in an .odt as italic, its own .odt's too; and a table's heading row as empty, LibreOffice's
    // own too: tables are left out here, and checked through LibreOffice elsewhere)
    // (nor does it read a code block in an .odt, its own included: they're left out of the .odt written for it)
    const noTables = (l) => !/^[•#>]*T/.test(l);
    const noCode = { ...doc, content: doc.content.filter((b) => b.type !== 'codeBlock') };
    if (noCode.content.length) assert.deepEqual(read('odt', await odtFromDoc(noCode, 'T')).filter(noTables), ourShape(noCode).filter(noTables).map((l) => l.replace(/\{([^}]*)\}/g, (m, k) => `{${[...new Set(k.split(',').filter(Boolean).map((x) => (x === 'underline' ? 'italic' : x)))].sort().join(',')}}`)), `document ${i}, .odt`);
  }
});

test('and 60 written by pandoc as .docx and .odt from our Markdown, opened in Docs: the same', { skip: !hasPandoc && 'pandoc isn’t installed here' }, async () => {
  // (underline, subscript and superscript are <u>, <sub> and <sup> in Markdown, which has no way of its own to write them:
  // pandoc leaves such HTML out of a .docx or .odt it makes, so those looks aren't expected back)
  const noHtmlLooks = (n) => { if (n.marks) { n.marks = n.marks.filter((m) => !['underline', 'subscript', 'superscript'].includes(m.type)); if (!n.marks.length) delete n.marks; } (n.content || []).forEach(noHtmlLooks); return n; };
  for (const [i, doc] of randomDocs(60, 2).entries()) {
    const want = ourShape(noHtmlLooks(JSON.parse(JSON.stringify(doc))));
    const md = markdownFromDoc(doc);
    assert.deepEqual(ourShape(await docFromWord(pandoc(['-f', 'gfm', '-t', 'docx'], md))), want, `document ${i}, pandoc's .docx of:\n${md}`);
    assert.deepEqual(ourShape(await docFromOdt(pandoc(['-f', 'gfm', '-t', 'odt'], md))), want, `document ${i}, pandoc's .odt of:\n${md}`);
  }
});

test('and 60 as Markdown written by pandoc (its own way of writing it, GitHub\'s and CommonMark\'s), opened in Docs: the same', { skip: !hasPandoc && 'pandoc isn’t installed here' }, async () => {
  // (compared with how pandoc itself reads that Markdown, as its writer isn't always clear)
  for (const [i, doc] of randomDocs(60, 3).entries()) {
    for (const to of ['gfm', 'commonmark']) {
      const md = String(pandoc(['-f', 'gfm', '-t', to], markdownFromDoc(doc)));
      if (/^\s*(?:(?:[-*+]|\d+[.)])\s+)?(~~~|```)/m.test(md) && !doc.content.some((b) => b.type === 'codeBlock')) continue; // (a line, or list item, pandoc began with "~~~": a code block to anyone reading it)
      // (and leaving out a line where pandoc reads one word with two looks, as it reads its own "~~~tilde~~~": "~", struck
      // "tilde", "~"; the random words never have that, so it's pandoc's writing that is unclear there)
      const theirs = read(to, md), ours = ourShape(await docFromMarkdown(md));
      if (theirs.includes('?RawBlock')) continue; // (CommonMark has no tables: pandoc writes one as HTML, which isn't read as a table)
      const unclear = new Set(theirs.map((l, k) => (/\{\?\}/.test(l) ? k : -1)).filter((k) => k >= 0));
      assert.deepEqual(ours.filter((l, k) => !unclear.has(k)), theirs.filter((l, k) => !unclear.has(k)), `document ${i}, pandoc's ${to}:\n${md}`);
    }
  }
});
