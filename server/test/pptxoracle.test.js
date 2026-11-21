// Presentations against another program: python-pptx, the library many tools make and read PowerPoint files with.
// Random decks (text boxes of several lines with accents, Hebrew, emoji, tabs, <&>; sizes, bold, italic, underline,
// alignment, colours; shapes with words, fills and turns; speaker notes) go out as .pptx for python-pptx to read, and
// python-pptx writes them for Slides to open. Both ways: each slide's items in order, where they are, their words and
// look, and the notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { powerPointFromDeck, deckFromPowerPoint } from '../src/office/powerpoint.js';

const python = (code, input) => { const r = spawnSync('python3', ['-I', '-c', code], { input, maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(String(r.stderr)); return JSON.parse(r.stdout); };
const hasPptx = spawnSync('python3', ['-c', 'import pptx']).status === 0;

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['alpha', 'Ωmega', 'naïve', 'x<y', 'a&b', '"q"', "it's", '中文', 'שלום', '😀', 'two  spaces', '1,234', '<tag>'];
const text = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(WORDS)).join(' ')).join('\n');
const SHAPES = { rect: 'RECTANGLE', ellipse: 'OVAL', star: 'STAR_5_POINT', triangle: 'ISOSCELES_TRIANGLE' };
function decks(n) {
  const item = (k) => {
    const base = { id: `i${k}`, x: Math.round(rnd() * 60), y: Math.round(rnd() * 60), w: 10 + Math.round(rnd() * 30), h: 5 + Math.round(rnd() * 20) };
    if (rnd() < 0.7) return { ...base, type: 'text', text: text(), size: pick([14, 18, 24, 32, 44]), ...(rnd() < 0.3 && { bold: true }), ...(rnd() < 0.3 && { italic: true }), ...(rnd() < 0.2 && { underline: true }), ...(rnd() < 0.3 && { align: pick(['center', 'right']) }), ...(rnd() < 0.3 && { color: pick(['#d93025', '#1a73e8', '#188038']) }) };
    return { ...base, type: 'shape', shape: pick(Object.keys(SHAPES)), fill: pick(['#ffd666', '#a142f4', '#ffffff']), ...(rnd() < 0.5 && { text: pick(WORDS) }), ...(rnd() < 0.3 && { rot: pick([15, 45, 90]) }) };
  };
  return Array.from({ length: n }, () => ({ theme: 'light', slides: Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, s) => ({ id: `s${s}`, ...(rnd() < 0.5 && { notes: text() }), items: Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, k) => item(k)) })) }));
}

// python-pptx's view of each slide: its shapes in order (where, as % of the slide; kind; words; the first run's look) and notes.
const READ = `
import sys, json, io, base64
from pptx import Presentation
from pptx.util import Emu
out = []
for b64 in json.load(sys.stdin):
    p = Presentation(io.BytesIO(base64.b64decode(b64)))
    W, H = p.slide_width, p.slide_height
    slides = [{'win': W / 914400}]
    for s in p.slides:
        items = []
        for sh in s.shapes:
            it = {'x': round(sh.left * 100 / W), 'y': round(sh.top * 100 / H), 'w': round(sh.width * 100 / W), 'h': round(sh.height * 100 / H), 'rot': round(sh.rotation or 0)}
            try: it['auto'] = str(sh.auto_shape_type).split('.')[-1].split(' ')[0]
            except Exception: it['auto'] = None
            try:
                if sh.fill.type == 1: it['fill'] = str(sh.fill.fore_color.rgb).upper()
            except Exception: pass
            if sh.has_text_frame:
                tf = sh.text_frame
                it['text'] = '\\n'.join(''.join(r.text for r in para.runs) for para in tf.paragraphs)
                runs = [r for para in tf.paragraphs for r in para.runs]
                if runs:
                    f = runs[0].font
                    it['size'] = f.size.pt if f.size else None
                    it['bold'], it['italic'], it['underline'] = bool(f.bold), bool(f.italic), bool(f.underline)
                    try: it['color'] = str(f.color.rgb).upper()
                    except Exception: it['color'] = None
                al = tf.paragraphs[0].alignment
                it['align'] = str(al).split('.')[-1].split(' ')[0].lower() if al is not None else None
            items.append(it)
        notes = s.notes_slide.notes_text_frame.text if s.has_notes_slide and s.notes_slide.notes_text_frame is not None else ''
        slides.append({'items': items, 'notes': notes})
    out.append(slides)
print(json.dumps(out))
`;

test('30 random decks as .pptx, read by python-pptx: each item where it is, its words and look, and the notes', { skip: !hasPptx && 'no python-pptx here' }, async () => {
  const list = decks(30);
  const files = await Promise.all(list.map((d) => powerPointFromDeck(d, { title: 'T' })));
  const got = python(READ, JSON.stringify(files.map((b) => Buffer.from(b).toString('base64'))));
  const wrong = [];
  list.forEach((d, i) => d.slides.forEach((s, j) => {
    const win = got[i][0].win, g = got[i][j + 1];
    if (!g) { wrong.push(`#${i} slide ${j + 1}: missing`); return; }
    if ((s.notes || '') !== g.notes) wrong.push(`#${i} slide ${j + 1} notes ${JSON.stringify(s.notes || '')} came as ${JSON.stringify(g.notes)}`);
    s.items.forEach((it, k) => {
      const t = g.items[k];
      if (!t) { wrong.push(`#${i} slide ${j + 1} item ${k + 1}: missing`); return; }
      const near = (a, b) => Math.abs(a - b) <= 1;
      for (const key of ['x', 'y', 'w', 'h']) if (!near(it[key], t[key])) wrong.push(`#${i} ${j + 1}.${k + 1} ${key} ${it[key]} came as ${t[key]}`);
      if ((it.rot || 0) !== t.rot) wrong.push(`#${i} ${j + 1}.${k + 1} rot ${it.rot || 0} came as ${t.rot}`);
      if ((it.text || '') !== (t.text || '')) wrong.push(`#${i} ${j + 1}.${k + 1} text ${JSON.stringify(it.text || '')} came as ${JSON.stringify(t.text)}`);
      if (it.type === 'shape') {
        if (t.auto !== SHAPES[it.shape]) wrong.push(`#${i} ${j + 1}.${k + 1} shape ${it.shape} came as ${t.auto}`);
        if (it.fill.slice(1).toUpperCase() !== t.fill) wrong.push(`#${i} ${j + 1}.${k + 1} fill ${it.fill} came as ${t.fill}`);
      } else {
        // (sizes are kept relative to the slide's width in Slides: in points, to a tenth)
        if (Math.abs(Math.round(it.size * win * 72 / 100) / 10 - t.size) > 0.05) wrong.push(`#${i} ${j + 1}.${k + 1} size ${it.size} came as ${t.size}`);
        for (const key of ['bold', 'italic', 'underline']) if (!!it[key] !== t[key]) wrong.push(`#${i} ${j + 1}.${k + 1} ${key} ${!!it[key]} came as ${t[key]}`);
        if (it.color && it.color.slice(1).toUpperCase() !== t.color) wrong.push(`#${i} ${j + 1}.${k + 1} color ${it.color} came as ${t.color}`);
        if ((it.align || 'left') !== (t.align || 'left')) wrong.push(`#${i} ${j + 1}.${k + 1} align ${it.align || 'left'} came as ${t.align}`);
      }
    });
    if (g.items.length !== s.items.length) wrong.push(`#${i} slide ${j + 1}: ${s.items.length} items came as ${g.items.length}`);
  }));
  assert.deepEqual(wrong.slice(0, 15), []);
});

test('and 30 written by python-pptx, opened in Slides: the same items, words, look and notes', { skip: !hasPptx && 'no python-pptx here' }, async () => {
  const list = decks(30);
  const WRITE = `
import sys, json, io, base64
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
out = []
for deck in json.load(sys.stdin):
    p = Presentation(); p.slide_width, p.slide_height = Emu(12192000), Emu(6858000)
    W, H, win = p.slide_width, p.slide_height, 12192000 / 914400
    for s in deck['slides']:
        slide = p.slides.add_slide(p.slide_layouts[6])
        for it in s['items']:
            box = dict(left=Emu(round(it['x'] * W / 100)), top=Emu(round(it['y'] * H / 100)), width=Emu(round(it['w'] * W / 100)), height=Emu(round(it['h'] * H / 100)))
            if it['type'] == 'shape':
                sh = slide.shapes.add_shape(getattr(MSO_SHAPE, it['auto']), **box)
                sh.fill.solid(); sh.fill.fore_color.rgb = RGBColor.from_string(it['fill'][1:])
                sh.line.fill.background()
                if it.get('rot'): sh.rotation = it['rot']
            else:
                sh = slide.shapes.add_textbox(**box)
            if it.get('text'):
                tf = sh.text_frame; tf.word_wrap = True
                for k, line in enumerate(it['text'].split('\\n')):
                    para = tf.paragraphs[0] if k == 0 else tf.add_paragraph()
                    r = para.add_run(); r.text = line
                    if it['type'] == 'text':
                        r.font.size = Pt(round(it['size'] * win * 72 / 100) / 10)
                        r.font.bold, r.font.italic, r.font.underline = bool(it.get('bold')), bool(it.get('italic')), bool(it.get('underline'))
                        if it.get('color'): r.font.color.rgb = RGBColor.from_string(it['color'][1:])
                        if it.get('align'): para.alignment = {'center': PP_ALIGN.CENTER, 'right': PP_ALIGN.RIGHT}[it['align']]
        if s.get('notes'): slide.notes_slide.notes_text_frame.text = s['notes']
    buf = io.BytesIO(); p.save(buf); out.append(base64.b64encode(buf.getvalue()).decode())
print(json.dumps(out))
`;
  const files = python(WRITE, JSON.stringify(list.map((d) => ({ slides: d.slides.map((s) => ({ ...s, items: s.items.map((it) => ({ ...it, auto: SHAPES[it.shape] })) })) }))));
  const wrong = [];
  for (const [i, d] of list.entries()) {
    const back = await deckFromPowerPoint(Buffer.from(files[i], 'base64'), { savePicture: async () => null });
    d.slides.forEach((s, j) => {
      const g = back.slides[j];
      if (!g) { wrong.push(`#${i} slide ${j + 1}: missing`); return; }
      if ((s.notes || '') !== (g.notes || '')) wrong.push(`#${i} slide ${j + 1} notes ${JSON.stringify(s.notes || '')} came back ${JSON.stringify(g.notes || '')}`);
      if (g.items.length !== s.items.length) wrong.push(`#${i} slide ${j + 1}: ${s.items.length} items came back ${g.items.length}`);
      s.items.forEach((it, k) => {
        const t = g.items[k] || {};
        const near = (a, b) => Math.abs((a || 0) - (b || 0)) <= 1;
        for (const key of ['x', 'y', 'w', 'h']) if (!near(it[key], t[key])) wrong.push(`#${i} ${j + 1}.${k + 1} ${key} ${it[key]} came back ${t[key]}`);
        if ((it.text || '') !== (t.text || '')) wrong.push(`#${i} ${j + 1}.${k + 1} text ${JSON.stringify(it.text || '')} came back ${JSON.stringify(t.text || '')}`);
        if (it.type !== t.type) { wrong.push(`#${i} ${j + 1}.${k + 1} a ${it.type} came back a ${t.type}`); return; }
        if (it.type === 'shape') {
          if (it.shape !== t.shape) wrong.push(`#${i} ${j + 1}.${k + 1} shape ${it.shape} came back ${t.shape}`);
          if (it.fill !== t.fill) wrong.push(`#${i} ${j + 1}.${k + 1} fill ${it.fill} came back ${t.fill}`);
          if ((it.rot || 0) !== Math.round(t.rot || 0)) wrong.push(`#${i} ${j + 1}.${k + 1} rot ${it.rot || 0} came back ${t.rot}`);
        } else {
          if (it.size !== t.size) wrong.push(`#${i} ${j + 1}.${k + 1} size ${it.size} came back ${t.size}`);
          for (const key of ['bold', 'italic', 'underline']) if (!!it[key] !== !!t[key]) wrong.push(`#${i} ${j + 1}.${k + 1} ${key} ${!!it[key]} came back ${!!t[key]}`);
          if (it.color && it.color !== t.color) wrong.push(`#${i} ${j + 1}.${k + 1} color ${it.color} came back ${t.color}`);
          if ((it.align || 'left') !== (t.align || 'left')) wrong.push(`#${i} ${j + 1}.${k + 1} align ${it.align || 'left'} came back ${t.align}`);
        }
      });
    });
  }
  assert.deepEqual(wrong.slice(0, 15), []);
});
