// Documents against another converter: pandoc. Random documents (headings, paragraphs, lists inside lists, quotes;
// bold, italic, underline, strikethrough, code, subscript, superscript, links; accents, Hebrew, Chinese, emoji and the
// characters Markdown uses) go out as Markdown, .docx and .odt and pandoc reads each; and pandoc turns our Markdown
// into .docx and .odt that Docs opens. Every way, the same blocks, nesting, words and each word's look.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { markdownFromDoc } from '../src/office/markdown.js';
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
  if (r < 0.85) return { type: pick(['bulletList', 'orderedList']), content: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ type: 'listItem', content: [P(), ...(rnd() < 0.3 ? [{ type: pick(['bulletList', 'orderedList']), content: [{ type: 'listItem', content: [P()] }] }] : [])] })) };
  return { type: 'blockquote', content: [P(), ...(rnd() < 0.3 ? [P()] : [])] };
}
const randomDocs = (n, start) => (seed = BASE + start, Array.from({ length: n }, () => ({ type: 'doc', content: Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => block()) })));

// ---- a document as lines to compare: "• • h2: word{bold} word{}" (nesting, kind, each word with its look) ----
const markName = (m) => (m.type === 'link' ? `link:${m.attrs.href}` : m.type);
function ourShape(doc) {
  const lines = [];
  const walk = (n, path) => {
    if (n.type === 'paragraph' || n.type === 'heading') {
      const ws = [];
      for (const t of n.content || []) for (const part of String(t.text || '').split(/(\s+)/)) if (part && !/^\s+$/.test(part)) ws.push(`${part}{${(t.marks || []).map(markName).sort().join(',')}}`);
      lines.push(`${path.join('')}${n.type === 'heading' ? `h${n.attrs.level}` : 'p'}: ${ws.join(' ')}`);
      return;
    }
    const mark = { bulletList: '•', orderedList: '#', blockquote: '>' }[n.type];
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
        case 'RawInline': { const tag = /^<(\/?)(u|sub|sup)>$/.exec(i.c[1]); if (tag) { const name = { u: 'underline', sub: 'subscript', sup: 'superscript' }[tag[2]]; if (tag[1]) raw.splice(raw.indexOf(name), 1); else raw.push(name); } else inl([{ t: 'Str', c: i.c[1] }], marks, ws, raw); break; }
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
    // (pandoc reads underline in an .odt as italic, its own .odt's too)
    assert.deepEqual(read('odt', await odtFromDoc(doc, 'T')), want.map((l) => l.replace(/\{([^}]*)\}/g, (m, k) => `{${[...new Set(k.split(',').filter(Boolean).map((x) => (x === 'underline' ? 'italic' : x)))].sort().join(',')}}`)), `document ${i}, .odt`);
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
