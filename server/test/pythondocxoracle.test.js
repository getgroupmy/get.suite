// Word files from another program: python-docx, the library many tools make Word files with. Random documents (headings,
// paragraphs of runs with bold, italic, underline and strikethrough each on or written off, colours, highlights and sizes;
// its own list styles, a level down too; quotes; tables) are written by it and opened in Docs: the same blocks, nesting,
// words and looks. (Docs' own Word files read by another program: see pandocoracle.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { docFromWord } from '../src/office/word.js';

const python = (code, input) => { const r = spawnSync('python3', ['-I', '-c', code], { input, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(String(r.stderr)); return JSON.parse(r.stdout); };
const hasDocx = spawnSync('python3', ['-c', 'import docx']).status === 0;

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['alpha', 'Ωmega', 'naïve', 'x<y', 'a&b', '"q"', "it's", '中文', 'שלום', '😀', '1,234', '#hash', '*star*'];
const COLORS = ['D93025', '1A73E8', '188038'];
const HIGHLIGHTS = { YELLOW: '#ffff00', BRIGHT_GREEN: '#00ff00', TURQUOISE: '#00ffff' };
const SIZES = [10, 18, 24]; // (Docs' own sizes besides the normal one)
// a run: its words and look; each look on, or written off (bold=False), or left out
const run = () => {
  const r = { text: pick(WORDS) };
  for (const k of ['bold', 'italic', 'underline', 'strike']) { const x = rnd(); if (x < 0.25) r[k] = true; else if (x < 0.4) r[k] = false; }
  if (rnd() < 0.15) r.color = pick(COLORS);
  if (rnd() < 0.1) r.highlight = pick(Object.keys(HIGHLIGHTS));
  if (rnd() < 0.1) r.size = pick(SIZES);
  return r;
};
const runs = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, run);
function docs(n) {
  return Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => {
    const r = rnd();
    if (r < 0.15) return { kind: 'heading', level: 1 + Math.floor(rnd() * 3), runs: runs() };
    if (r < 0.5) return { kind: 'p', runs: runs() };
    if (r < 0.75) { const style = pick(['List Bullet', 'List Number']); return { kind: 'list', items: Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => ({ style: k && rnd() < 0.3 ? `${style} 2` : style, runs: runs() })) }; }
    if (r < 0.85) return { kind: 'quote', runs: runs() };
    return { kind: 'table', rows: Array.from({ length: 2 }, () => Array.from({ length: 2 }, runs)) };
  }));
}

// What's compared: lines of "path kind: word{looks} …" (path: • bullet, # numbered, > quote, T table cell).
const looksOf = (r) => [r.bold && 'bold', r.italic && 'italic', r.underline && 'underline', r.strike && 'strike', r.color && `color:#${r.color.toLowerCase()}`, r.highlight && `bg:${HIGHLIGHTS[r.highlight]}`, r.size && `size:${r.size}pt`].filter(Boolean).sort().join(',');
const runWords = (rs) => rs.map((r) => `${r.text}{${looksOf(r)}}`).join(' ');
function expected(spec) {
  const out = [];
  for (const b of spec) {
    if (b.kind === 'heading') out.push(`h${b.level}: ${runWords(b.runs)}`);
    else if (b.kind === 'p') out.push(`p: ${runWords(b.runs)}`);
    else if (b.kind === 'quote') out.push(`>p: ${runWords(b.runs)}`);
    else if (b.kind === 'table') for (const row of b.rows) for (const cell of row) out.push(`Tp: ${runWords(cell)}`);
    else {
      // an item a level down (… 2) goes in the item before it, in a list of its own kind; the first can't be one
      for (const it of b.items) { const mark = /Number/.test(it.style) ? '#' : '•'; const top = /Number/.test(b.items[0].style) ? '#' : '•'; out.push(`${/ 2$/.test(it.style) ? top + mark : top}p: ${runWords(it.runs)}`); }
    }
  }
  return out;
}
function shapeOf(doc) {
  const out = [];
  const walk = (n, path) => {
    if (n.type === 'paragraph' || n.type === 'heading') {
      const words = (n.content || []).filter((t) => t.type === 'text' && t.text.trim()).flatMap((t) => {
        const looks = [];
        for (const m of t.marks || []) {
          if (['bold', 'italic', 'underline', 'strike'].includes(m.type)) looks.push(m.type);
          if (m.type === 'textStyle') { if (m.attrs?.color) looks.push(`color:${m.attrs.color.toLowerCase()}`); if (m.attrs?.backgroundColor) looks.push(`bg:${m.attrs.backgroundColor.toLowerCase()}`); if (m.attrs?.fontSize) looks.push(`size:${m.attrs.fontSize}`); }
          if (m.type === 'highlight') looks.push(`bg:${String(m.attrs?.color || '').toLowerCase()}`);
        }
        return t.text.trim().split(/\s+/).map((w) => `${w}{${looks.sort().join(',')}}`);
      });
      out.push(`${path}${n.type === 'heading' ? `h${n.attrs.level}` : 'p'}: ${words.join(' ')}`);
      return;
    }
    const mark = { bulletList: '•', orderedList: '#', blockquote: '>', table: 'T' }[n.type] || '';
    for (const c of n.content || []) walk(c, path + mark);
  };
  walk(doc.doc || doc, '');
  return out;
}

const WRITE = `
import sys, json, io, base64
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_COLOR_INDEX
def runs(p, rs):
    for k, r in enumerate(rs):
        x = p.add_run(r['text'] + (' ' if k < len(rs) - 1 else ''))
        for key in ('bold', 'italic', 'underline'):
            if key in r: setattr(x, key, r[key])
        if 'strike' in r: x.font.strike = r['strike']
        if r.get('color'): x.font.color.rgb = RGBColor.from_string(r['color'])
        if r.get('highlight'): x.font.highlight_color = getattr(WD_COLOR_INDEX, r['highlight'])
        if r.get('size'): x.font.size = Pt(r['size'])
out = []
for spec in json.load(sys.stdin):
    d = Document()
    for b in spec:
        if b['kind'] == 'heading': runs(d.add_heading('', level=b['level']), b['runs'])
        elif b['kind'] == 'p': runs(d.add_paragraph(), b['runs'])
        elif b['kind'] == 'quote': runs(d.add_paragraph(style='Quote'), b['runs'])
        elif b['kind'] == 'list':
            for it in b['items']: runs(d.add_paragraph(style=it['style']), it['runs'])
        else:
            t = d.add_table(rows=2, cols=2)
            for i, row in enumerate(b['rows']):
                for j, cell in enumerate(row): runs(t.cell(i, j).paragraphs[0], cell)
            d.add_paragraph()
    buf = io.BytesIO(); d.save(buf); out.append(base64.b64encode(buf.getvalue()).decode())
print(json.dumps(out))
`;

test('40 random documents written by python-docx, opened in Docs: the same blocks, nesting, words and looks', { skip: !hasDocx && 'no python-docx here' }, async () => {
  const list = docs(40);
  const files = python(WRITE, JSON.stringify(list));
  const wrong = [];
  for (const [i, spec] of list.entries()) {
    const got = shapeOf(await docFromWord(Buffer.from(files[i], 'base64'))).filter((l) => l !== 'p: '); // (the empty paragraph after a table)
    const want = expected(spec);
    if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push({ i, want, got });
  }
  assert.deepEqual(wrong.slice(0, 2), []);
});
