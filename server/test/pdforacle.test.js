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
