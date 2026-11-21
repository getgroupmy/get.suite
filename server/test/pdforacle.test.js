// A document's PDF download against other programs reading it: pypdf (the outline and the links) and pdfplumber (the
// words on each page). Random documents long enough for several pages (headings of three levels, paragraphs with links
// to addresses with accents, brackets, & and ?, mailto: links; accents, Chinese, emoji) give a PDF whose outline lists
// every heading in order at its level and on the page it's on, whose links go where they say, and whose words come in
// the order written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pdfFromDoc } from '../src/office/pdfdoc.js';

const python = (code, input) => { const r = spawnSync('python3', ['-I', '-c', code], { input, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(String(r.stderr)); return JSON.parse(r.stdout); };
const hasPy = spawnSync('python3', ['-c', 'import pypdf, pdfplumber']).status === 0;

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['alpha', 'naïve', 'résumé', 'Ωmega', 'budget', 'plan', 'x<y', 'a&b', 'quarterly', 'report', 'figures', 'Zoë', 'Müller'];
const URLS = ['https://example.com/a?b=1&c=2', 'https://example.com/naïve/résumé', 'https://example.com/wiki/Foo_(bar)', 'mailto:zoe@example.org', 'https://example.com/%E2%82%AC/x y', 'http://example.org/#frag'];
function docs(n) {
  return Array.from({ length: n }, (_, d) => {
    const content = [];
    let h = 0;
    for (let k = 0; k < 20 + Math.floor(rnd() * 40); k++) {
      if (rnd() < 0.25) content.push({ type: 'heading', attrs: { level: 1 + Math.floor(rnd() * 3) }, content: [{ type: 'text', text: `Heading ${d}.${++h} ${pick(WORDS)}` }] });
      else {
        const parts = [];
        for (let w = 0; w < 30 + Math.floor(rnd() * 90); w++) {
          if (parts.length) parts.push({ type: 'text', text: ' ' });
          parts.push(rnd() < 0.05 ? { type: 'text', text: pick(WORDS), marks: [{ type: 'link', attrs: { href: pick(URLS) } }] } : { type: 'text', text: pick(WORDS) });
        }
        content.push({ type: 'paragraph', content: parts });
      }
    }
    return { type: 'doc', content };
  });
}

const READ = `
import sys, json, io, base64, pypdf, pdfplumber
out = []
for b64 in json.load(sys.stdin):
    data = base64.b64decode(b64)
    r = pypdf.PdfReader(io.BytesIO(data))
    outline = []
    def walk(items, level):
        for it in items:
            if isinstance(it, list): walk(it, level + 1)
            else: outline.append({'title': it.title, 'level': level, 'page': r.get_destination_page_number(it)})
    walk(r.outline, 1)
    links = []
    for p in r.pages:
        for a in p.get('/Annots') or []:
            a = a.get_object()
            if a.get('/Subtype') == '/Link' and '/A' in a and '/URI' in a['/A']: links.append(str(a['/A']['/URI']))
    with pdfplumber.open(io.BytesIO(data)) as pl:
        pages = [p.extract_text() or '' for p in pl.pages]
    out.append({'outline': outline, 'links': links, 'pages': pages})
print(json.dumps(out))
`;

test('25 random documents as PDF: the outline (headings, levels, pages), the links and the words, as pypdf and pdfplumber read them', { skip: !hasPy && 'no pypdf or pdfplumber here' }, async () => {
  const list = docs(25);
  const files = await Promise.all(list.map((d) => pdfFromDoc(d, 'T')));
  const got = python(READ, JSON.stringify(files.map((b) => Buffer.from(b).toString('base64'))));
  const wrong = [];
  list.forEach((doc, i) => {
    const g = got[i];
    const heads = doc.content.filter((b) => b.type === 'heading').map((b) => ({ title: b.content[0].text, level: b.attrs.level }));
    // (a heading below one of a lower level than the one before it sits under it in the outline: its depth there)
    const depth = []; let stack = [];
    for (const h of heads) { while (stack.length && stack[stack.length - 1] >= h.level) stack.pop(); stack.push(h.level); depth.push(stack.length); }
    const want = heads.map((h, k) => `${depth[k]} ${h.title}`), have = g.outline.map((o) => `${o.level} ${o.title}`);
    if (JSON.stringify(want) !== JSON.stringify(have)) wrong.push(`#${i} outline ${JSON.stringify(want)} came as ${JSON.stringify(have)}`);
    g.outline.forEach((o) => { if (!(g.pages[o.page] || '').includes(o.title)) wrong.push(`#${i} "${o.title}" points at page ${o.page + 1}, which doesn't have it`); });
    const hrefs = doc.content.flatMap((b) => (b.content || []).flatMap((t) => (t.marks || []).filter((m) => m.type === 'link').map((m) => m.attrs.href)));
    const missing = [...new Set(hrefs)].filter((h) => !g.links.includes(h));
    if (missing.length) wrong.push(`#${i} links ${JSON.stringify(missing)} not among ${JSON.stringify([...new Set(g.links)])}`);
    // the words in order (each found after the one before)
    const text = g.pages.join('\n').replace(/\s+/g, ' ');
    let at = 0;
    for (const w of doc.content.flatMap((b) => (b.content || []).map((t) => t.text).join('').split(/\s+/).filter(Boolean))) {
      const k = text.indexOf(w, at);
      if (k < 0) { wrong.push(`#${i} "${w}" not found after character ${at}`); break; }
      at = k + w.length;
    }
  });
  assert.deepEqual(wrong.slice(0, 10), []);
});

test('spreadsheet PDFs: 15 random sheets with pictures, read by pdfplumber: each picture on the page with its cell, its corner in that cell, its shape kept', { skip: !hasPy && 'no pypdf/pdfplumber here' }, async () => {
  const { pdfFromSheet } = await import('../src/office/sheetpdf.js');
  const { spawnSync: run } = await import('node:child_process');
  const pil = run('python3', ['-c', 'import PIL']).status === 0;
  if (!pil) return;
  let s = Number(process.env.SEED) || 20261121;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const L = (i) => String.fromCharCode(65 + i);
  for (let n = 0; n < 15; n++) {
    const colWidths = {}, rowHeights = {};
    for (let c = 0; c < 14; c++) if (rnd() < 0.3) colWidths[L(c)] = int(50, 220);
    for (let r = 1; r <= 80; r++) if (rnd() < 0.1) rowHeights[String(r)] = int(20, 60);
    const cells = {}, pictures = {}, want = [];
    const colX = (c) => { let x = 0; for (let k = 0; k < c; k++) x += colWidths[L(k)] ?? 100; return x; };
    const rowY = (r) => { let y = 0; for (let k = 1; k <= r; k++) y += rowHeights[String(k)] ?? 24; return y; };
    for (let k = 0; k < int(1, 4); k++) {
      const c = int(0, 13), r = int(0, 79), key = `${L(c)}${r + 1}`;
      if (cells[key]) continue;
      cells[key] = key; // (the cell says which it is)
      const w = int(10, 180), h = int(10, 120);
      const ox = int(0, (colWidths[L(c)] ?? 100) - 6), oy = int(0, (rowHeights[String(r + 1)] ?? 24) - 6);
      pictures[`p${k}`] = { file: `f${k}`, x: 46 + colX(c) + ox, y: 24 + rowY(r) + oy, w, h, kind: rnd() < 0.5 ? 'PNG' : 'JPEG' };
      want.push({ key, w, h });
    }
    const data = JSON.parse(run('python3', ['-I', '-c', `
import sys, json, io, base64
from PIL import Image
out = {}
for k, p in json.load(sys.stdin).items():
    b = io.BytesIO(); Image.new('RGB', (p['w'], p['h']), (30, 90, 200)).save(b, p['kind']); out[p['file']] = [base64.b64encode(b.getvalue()).decode(), 'image/png' if p['kind'] == 'PNG' else 'image/jpeg']
print(json.dumps(out))`], { input: JSON.stringify(pictures) }).stdout);
    const sheet = { name: 'Sheet1', cells, colWidths, rowHeights, pictures: Object.fromEntries(Object.entries(pictures).map(([k, { kind, ...p }]) => [k, p])) };
    const pdf = await pdfFromSheet({ sheets: [sheet] }, 'Pictures', { pictureData: async (id) => ({ data: Buffer.from(data[id][0], 'base64'), mime: data[id][1] }) });
    const seen = python(`
import sys, json, io, base64, pdfplumber
out = []
with pdfplumber.open(io.BytesIO(base64.b64decode(sys.stdin.read()))) as pdf:
    for page in pdf.pages:
        words = page.extract_words()
        rects = [r for r in page.rects if r['width'] > 5 and r['height'] > 5]
        for im in page.images:
            x, t = im['x0'] + 0.3, im['top'] + 0.3
            cell = [r for r in rects if r['x0'] <= x < r['x1'] and r['top'] <= t < r['bottom']]
            label = [w['text'] for w in words if cell and cell[0]['x0'] <= w['x0'] < cell[0]['x1'] and cell[0]['top'] <= w['top'] < cell[0]['bottom']]
            out.append({ 'page': page.page_number, 'label': label, 'w': im['width'], 'h': im['height'] })
print(json.dumps(out))`, pdf.toString('base64'));
    // The pictures themselves, by pypdf (pdfplumber gives two plain one-colour JPEGs on a page the first one's size).
    const sources = python(`
import sys, io, json, base64, pypdf
print(json.dumps(sorted([list(i.image.size) for pg in pypdf.PdfReader(io.BytesIO(base64.b64decode(sys.stdin.read()))).pages for i in pg.images])))`, pdf.toString('base64'));
    assert.deepEqual(sources, want.map((w) => [w.w, w.h]).sort((a, b) => a[0] - b[0] || a[1] - b[1]), `sheet ${n}: the pictures themselves, each once ${JSON.stringify(sheet)}`);
    assert.equal(seen.length, want.length, `sheet ${n}: every picture drawn once (${JSON.stringify(seen)})`);
    for (const w of want) {
      const got = seen.find((g) => g.label.includes(w.key));
      assert.ok(got, `sheet ${n}: the picture of ${w.key} has its corner in ${w.key}: ${JSON.stringify(seen)} ${JSON.stringify(sheet.pictures)}`);
      assert.ok(Math.abs(got.w / got.h - w.w / w.h) < 0.02 && got.w <= w.w * 0.75 + 0.5, `sheet ${n}: its shape kept, at most 3/4 size: ${JSON.stringify(got)}`);
    }
  }
});

test('a small JPEG (under 4 KB, as Node reads it: a slice of a shared buffer) is in Docs, Slides and Sheets PDFs; pdf-lib took it for not a JPEG, and the picture was left out', { skip: !hasPy && 'no pypdf here' }, async () => {
  const { spawnSync: run } = await import('node:child_process');
  if (run('python3', ['-c', 'import PIL']).status !== 0) return;
  const jpg = run('python3', ['-I', '-c', "import sys, io\nfrom PIL import Image\nb = io.BytesIO(); Image.new('RGB', (40, 30), (200, 60, 20)).save(b, 'JPEG'); sys.stdout.buffer.write(b.getvalue())"]).stdout;
  const pooled = Buffer.from(jpg.toString('base64'), 'base64'); // (small buffers share Node's pool, as fs.readFileSync's do)
  assert.ok(pooled.byteOffset > 0 || Buffer.poolSize < jpg.length, 'a slice of the shared pool');
  const pictureData = async () => ({ data: pooled, mime: 'image/jpeg' });
  const { pdfFromDoc } = await import('../src/office/pdfdoc.js');
  const { pdfFromDeck } = await import('../src/office/slidepdf.js');
  const { pdfFromSheet } = await import('../src/office/sheetpdf.js');
  const made = {
    doc: await pdfFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Logo:' }] }, { type: 'image', attrs: { fileId: 'logo', src: '/x' } }] }, 'D', { pictureData }),
    slides: await pdfFromDeck({ slides: [{ id: 's', items: [{ id: 'i', type: 'image', fileId: 'logo', x: 10, y: 10, w: 30, h: 20 }] }] }, 'S', { pictureData }),
    sheet: await pdfFromSheet({ sheets: [{ name: 'S', cells: { A1: 'x' }, pictures: { p: { file: 'logo', x: 46, y: 24, w: 40, h: 30 } } }] }, 'T', { pictureData }),
  };
  for (const [kind, pdf] of Object.entries(made)) {
    const sizes = python(`
import sys, io, json, base64, pypdf
print(json.dumps([list(i.image.size) for pg in pypdf.PdfReader(io.BytesIO(base64.b64decode(sys.stdin.read()))).pages for i in pg.images]))`, pdf.toString('base64'));
    assert.deepEqual(sizes, [[40, 30]], `${kind}: the picture`);
  }
});
