// A small TrueType reader and subsetter, for PDFs with text beyond Latin (Greek, Cyrillic, Chinese, Japanese, Thai,
// Tamil…): which characters a font has, how wide each is, and the font cut down to the glyphs a document uses, so a
// 17 MB Chinese font adds only what's drawn. TrueType outlines (glyf) only; CFF fonts (OTTO) are left to others.
// Collections (.ttc) give their first font. Enough of fontkit's shape for pdf-lib to embed it (fontkitShim).

const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Parse a .ttf or .ttc file (its first font). null when it isn't TrueType outlines. */
export function parseTtf(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let base = 0;
  if (tag(b, 0) === 'ttcf') base = v.getUint32(12);
  const sfnt = v.getUint32(base);
  if (sfnt !== 0x00010000 && tag(b, base) !== 'true') return null; // (OTTO: CFF outlines)
  const tables = {};
  const n = v.getUint16(base + 4);
  for (let i = 0; i < n; i++) {
    const r = base + 12 + i * 16;
    tables[tag(b, r)] = { offset: v.getUint32(r + 8), length: v.getUint32(r + 12) };
  }
  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf']) if (!tables[t]) return null; // (no cmap: a subset of ours)
  const T = (t) => tables[t].offset;
  const unitsPerEm = v.getUint16(T('head') + 18);
  const bbox = { minX: v.getInt16(T('head') + 36), minY: v.getInt16(T('head') + 38), maxX: v.getInt16(T('head') + 40), maxY: v.getInt16(T('head') + 42) };
  const longLoca = v.getInt16(T('head') + 50) === 1;
  const ascent = v.getInt16(T('hhea') + 4), descent = v.getInt16(T('hhea') + 6), nHMetrics = v.getUint16(T('hhea') + 34);
  const numGlyphs = v.getUint16(T('maxp') + 4);
  let capHeight = 0, xHeight = 0;
  if (tables['OS/2'] && v.getUint16(T('OS/2')) >= 2 && tables['OS/2'].length >= 90) { xHeight = v.getInt16(T('OS/2') + 86); capHeight = v.getInt16(T('OS/2') + 88); }
  const italicAngle = tables.post ? v.getInt32(T('post') + 4) / 65536 : 0;
  const advance = (g) => v.getUint16(T('hmtx') + 4 * Math.min(g, nHMetrics - 1));
  const locaAt = (g) => (longLoca ? v.getUint32(T('loca') + 4 * g) : v.getUint16(T('loca') + 2 * g) * 2);

  // cmap: Unicode (3,10) format 12 if there is one, else (3,1) or (0,*) format 4
  const cmapOff = tables.cmap ? T('cmap') : 0, subs = [];
  for (let i = 0; cmapOff && i < v.getUint16(cmapOff + 2); i++) {
    const r = cmapOff + 4 + i * 8;
    subs.push({ pid: v.getUint16(r), eid: v.getUint16(r + 2), off: cmapOff + v.getUint32(r + 4) });
  }
  const fmt = (s) => v.getUint16(s.off);
  const pickSub = subs.find((s) => s.pid === 3 && s.eid === 10 && fmt(s) === 12) || subs.find((s) => s.pid === 0 && fmt(s) === 12)
    || subs.find((s) => s.pid === 3 && s.eid === 1 && fmt(s) === 4) || subs.find((s) => s.pid === 0 && fmt(s) === 4);
  const map = new Map();
  if (pickSub && fmt(pickSub) === 12) {
    const groups = v.getUint32(pickSub.off + 12);
    for (let i = 0; i < groups; i++) {
      const r = pickSub.off + 16 + i * 12, start = v.getUint32(r), end = v.getUint32(r + 4), g0 = v.getUint32(r + 8);
      for (let c = start; c <= end && c - start < 0x30000; c++) map.set(c, g0 + (c - start));
    }
  } else if (pickSub) {
    const o = pickSub.off, segX2 = v.getUint16(o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = v.getUint16(ends + 2 * s), start = v.getUint16(starts + 2 * s), delta = v.getInt16(deltas + 2 * s), ro = v.getUint16(ranges + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (!ro) g = (c + delta) & 0xffff;
        else { const at = ranges + 2 * s + ro + 2 * (c - start); g = v.getUint16(at); if (g) g = (g + delta) & 0xffff; }
        if (g && g < numGlyphs) map.set(c, g);
      }
    }
  }
  // the PostScript name (name id 6)
  let postscriptName = 'Font';
  if (tables.name) {
    const no = T('name'), count = v.getUint16(no + 2), strs = no + v.getUint16(no + 4);
    for (let i = 0; i < count; i++) {
      const r = no + 6 + i * 12;
      if (v.getUint16(r + 6) !== 6) continue;
      const pid = v.getUint16(r), len = v.getUint16(r + 8), off = strs + v.getUint16(r + 10);
      const bytes = b.subarray(off, off + len);
      postscriptName = pid === 3 || pid === 0 ? String.fromCharCode(...Array.from({ length: len / 2 }, (_, k) => (bytes[2 * k] << 8) | bytes[2 * k + 1])) : String.fromCharCode(...bytes);
      if (pid === 3) break;
    }
  }
  // (the flags pdf-lib reads: fixed pitch, serif from the family class, italic)
  const isFixedPitch = tables.post ? v.getUint32(T('post') + 12) !== 0 : false;
  const sFamilyClass = tables['OS/2'] ? v.getInt16(T('OS/2') + 30) : 0;
  const macItalic = !!(v.getUint16(T('head') + 44) & 2);
  return { isFixedPitch, sFamilyClass, macItalic, b, v, tables, unitsPerEm, bbox, ascent, descent, capHeight, xHeight, italicAngle, numGlyphs, nHMetrics, longLoca, map, advance, locaAt, postscriptName: postscriptName.replace(/[^\x21-\x7e]/g, '') || 'Font' };
}

/** Glyphs a composite glyph is made of (so they're kept too). */
function components(f, g) {
  const s = f.tables.glyf.offset + f.locaAt(g), e = f.tables.glyf.offset + f.locaAt(g + 1);
  if (e - s < 10 || f.v.getInt16(s) >= 0) return [];
  const out = [];
  let p = s + 10, flags;
  do {
    flags = f.v.getUint16(p); out.push(f.v.getUint16(p + 2)); p += 4;
    p += flags & 0x1 ? 4 : 2; // the arguments: words or bytes
    p += flags & 0x8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0; // a scale, x and y scales, or a 2×2
  } while (flags & 0x20 && p < e);
  return out;
}

const pad4 = (n) => (n + 3) & ~3;
const sum32 = (b) => { let s = 0; for (let i = 0; i < b.length; i += 4) s = (s + ((b[i] << 24) | ((b[i + 1] || 0) << 16) | ((b[i + 2] || 0) << 8) | (b[i + 3] || 0))) >>> 0; return s; };

/**
 * The font with only these glyphs drawn (the rest kept as empty glyphs, so glyph numbers stay the same): a standalone
 * .ttf for a PDF's FontFile2. Hinting (cvt, fpgm, prep) and metrics come along; cmap doesn't (the PDF maps by glyph).
 */
export function subsetTtf(f, glyphIds) {
  const keep = new Set([0, ...glyphIds]);
  for (const g of [...keep]) for (const c of components(f, g)) if (c < f.numGlyphs) keep.add(c); // (components of components: one level is what fonts use)
  for (const g of [...keep]) for (const c of components(f, g)) if (c < f.numGlyphs) keep.add(c);
  const parts = [], offs = [0];
  let at = 0;
  for (let g = 0; g < f.numGlyphs; g++) {
    if (keep.has(g)) {
      const s = f.tables.glyf.offset + f.locaAt(g), e = f.tables.glyf.offset + f.locaAt(g + 1);
      const data = f.b.subarray(s, e), padded = new Uint8Array(pad4(data.length)); padded.set(data);
      parts.push(padded); at += padded.length;
    }
    offs.push(at);
  }
  const glyf = new Uint8Array(at); let p = 0; for (const x of parts) { glyf.set(x, p); p += x.length; }
  const loca = new Uint8Array(4 * (f.numGlyphs + 1)), lv = new DataView(loca.buffer);
  offs.forEach((o, i) => lv.setUint32(4 * i, o));
  const copy = (t) => f.b.slice(f.tables[t].offset, f.tables[t].offset + f.tables[t].length);
  const head = copy('head'); new DataView(head.buffer).setInt16(50, 1); new DataView(head.buffer).setUint32(8, 0); // long loca; checksum adjusted below
  const post = new Uint8Array(32); if (f.tables.post) post.set(f.b.subarray(f.tables.post.offset, f.tables.post.offset + 32)); new DataView(post.buffer).setUint32(0, 0x00030000); // format 3: no glyph names
  const out = { head, hhea: copy('hhea'), maxp: copy('maxp'), hmtx: copy('hmtx'), loca, glyf, post };
  for (const t of ['cvt ', 'fpgm', 'prep', 'OS/2', 'name']) if (f.tables[t]) out[t] = copy(t);
  const tags = Object.keys(out).sort();
  const dirLen = 12 + 16 * tags.length;
  let size = dirLen; for (const t of tags) size += pad4(out[t].length);
  const file = new Uint8Array(size), fv = new DataView(file.buffer);
  fv.setUint32(0, 0x00010000); fv.setUint16(4, tags.length);
  const es = Math.floor(Math.log2(tags.length)); fv.setUint16(6, 16 * 2 ** es); fv.setUint16(8, es); fv.setUint16(10, tags.length * 16 - 16 * 2 ** es);
  let off = dirLen, headAt = 0;
  tags.forEach((t, i) => {
    const r = 12 + 16 * i, data = out[t];
    for (let k = 0; k < 4; k++) file[r + k] = t.charCodeAt(k);
    fv.setUint32(r + 4, sum32(data)); fv.setUint32(r + 8, off); fv.setUint32(r + 12, data.length);
    file.set(data, off); if (t === 'head') headAt = off; off += pad4(data.length);
  });
  fv.setUint32(headAt + 8, (0xb1b0afba - sum32(file)) >>> 0);
  return file;
}

/**
 * A font for pdf-lib's custom-font embedder, without fontkit: it lays text out a character to a glyph (no kerning or
 * shaping) and remembers which glyphs were drawn. Before saving, `finish(pdfFont)` puts the subset in its place.
 */
export function fontkitShim(f, unicodeOf = (cp) => [cp]) {
  const used = new Map(); // code point → glyph
  const glyph = (cp) => {
    const id = f.map.get(cp) || 0;
    if (id) used.set(cp, id);
    return { id, advanceWidth: f.advance(id), codePoints: unicodeOf(cp) }; // (what copying it gives: Arabic forms as their letters)
  };
  const font = {
    unitsPerEm: f.unitsPerEm, ascent: f.ascent, descent: f.descent, capHeight: f.capHeight, xHeight: f.xHeight, italicAngle: f.italicAngle, bbox: f.bbox,
    postscriptName: f.postscriptName, cff: undefined,
    post: { isFixedPitch: f.isFixedPitch }, 'OS/2': { sFamilyClass: f.sFamilyClass }, head: { macStyle: { italic: f.macItalic } },
    get characterSet() { return [...used.keys()]; },
    glyphForCodePoint: (cp) => glyph(cp),
    layout: (text) => ({ glyphs: [...String(text)].map((ch) => glyph(ch.codePointAt(0))) }),
  };
  return {
    fontkit: { create: async () => font },
    has: (cp) => f.map.has(cp),
    width: (text, size) => [...String(text)].reduce((a, ch) => a + f.advance(f.map.get(ch.codePointAt(0)) || 0), 0) * (size / f.unitsPerEm),
    finish: (pdfFont) => { pdfFont.embedder.fontData = subsetTtf(f, [...used.values()]); },
  };
}
