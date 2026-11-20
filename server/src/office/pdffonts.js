import fs from 'node:fs';
import path from 'node:path';
import { parseTtf, fontkitShim } from './ttf.js';
import { visual, logicalOf, shapeArabic } from './bidi.js';

// pdf-lib measures standard-font text with kerning, but draws it without: words laid out by those measurements end
// up a little too close (after "y," a space all but vanishes). Measure as drawn: each character's own width.
export function asDrawn(font) {
  const one = font.widthOfTextAtSize.bind(font);
  const cache = new Map();
  font.widthOfTextAtSize = (text, size) => {
    let w = 0;
    for (const ch of String(text)) { let u = cache.get(ch); if (u === undefined) { u = one(ch, 1000) / 1000; cache.set(ch, u); } w += u; }
    return w * size;
  };
  return font;
}

// ---- characters beyond the standard fonts (Greek, Cyrillic, Chinese, Japanese, Korean, Thai, Tamil, symbols…): from
// the fonts installed on this computer (PDF_FONT_DIRS, else the usual places), each cut down to what's drawn (ttf.js).

let installed = null; // [{ file, bold }] in the order to try them
const parsed = new Map(); // file → parsed font (or null)
function fontFiles() {
  if (installed) return installed;
  const dirs = (process.env.PDF_FONT_DIRS || '/usr/share/fonts:/usr/local/share/fonts').split(':').filter(Boolean);
  const files = [];
  const walk = (d, depth) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 5) walk(p, depth + 1); else if (/\.(ttf|ttc)$/i.test(e.name)) files.push(p); } };
  dirs.forEach((d) => walk(d, 0));
  // Sans first (DejaVu and Noto cover most scripts), Chinese/Japanese/Korean, then the rest; monospaced, italic and
  // sample fonts last
  const rank = (f) => { const n = path.basename(f).toLowerCase(); return (/mono|italic|oblique|sample|emoji/.test(n) ? 100 : 0) + (/^dejavusans[-.]/.test(n) ? 0 : /^notosans/.test(n) ? 1 : /^freesans/.test(n) ? 2 : /wqy|zenhei|ipag|noto.*cjk|droidsansfallback/.test(n) ? 3 : /serif/.test(n) ? 6 : 4); };
  installed = files.map((file) => ({ file, bold: /bold/i.test(path.basename(file)) })).sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));
  return installed;
}
const parsedFont = (file) => { if (!parsed.has(file)) { let f = null; try { f = parseTtf(fs.readFileSync(file)); } catch { f = null; } parsed.set(file, f); } return parsed.get(file); };

/**
 * Fonts for a PDF whose text may go beyond the standard fonts: `wrap(pdfFont, bold)` gives a font that measures and
 * (on pages from `page(p)`) draws each character in the standard font when it has it, else in the first installed font
 * that does. `chars` (all the document's text) decides which installed fonts are embedded. `drawable(ch)`: can it be
 * drawn at all ("?" otherwise). `finish()` before saving: each embedded font cut down to the glyphs drawn.
 */
export async function withFallbackFonts(pdf, chars, sample) {
  const can = new Map(); // character → standard font has it
  const std = (ch) => { if (!can.has(ch)) { let ok = true; try { sample.encodeText(ch); } catch { ok = false; } can.set(ch, ok); } return can.get(ch); };
  const needed = [...new Set([...chars, ...shapeArabic(chars)])].filter((ch) => !/\s/.test(ch) && !std(ch)).map((ch) => ch.codePointAt(0));
  const shims = new Map(); // bytes → shim, for the one fontkit stand-in pdf-lib is given
  const picks = { r: [], b: [] }; // [{ has, shim, font }]
  if (needed.length) {
    pdf.registerFontkit({ create: async (bytes) => shims.get(bytes).fontkitFont });
    for (const bold of [false, true]) { // regular text from regular fonts; bold from bold ones first, then regular
      const left = new Set(needed);
      const order = fontFiles().filter((x) => (bold ? true : !x.bold)).sort((x, y) => (bold ? Number(y.bold) - Number(x.bold) : 0));
      for (const { file } of order) {
        if (!left.size) break;
        const f = parsedFont(file);
        const covers = f ? [...left].filter((cp) => f.map.has(cp)) : [];
        if (!covers.length) continue;
        const shim = fontkitShim(f, logicalOf), bytes = new Uint8Array(0);
        shim.fontkitFont = await shim.fontkit.create();
        shims.set(bytes, shim);
        (bold ? picks.b : picks.r).push({ has: shim.has, shim, font: await pdf.embedFont(bytes, { subset: false }) });
        covers.forEach((cp) => left.delete(cp));
      }
    }
  }
  const fallback = (ch, bold) => (bold ? picks.b : picks.r).find((p) => p.has(ch.codePointAt(0))) || picks.r.find((p) => p.has(ch.codePointAt(0)));
  /** Text in runs, each with the font to draw it in. */
  const runs = (text, base, bold) => {
    const out = [];
    for (let ch of String(text)) {
      const fb = std(ch) || /\s/.test(ch) ? null : fallback(ch, bold);
      if (!fb && !std(ch)) ch = /\s/.test(ch) ? ' ' : '?'; // (no font has it, as when one has Arabic letters but not their joined forms)
      const key = fb || null;
      if (out.length && out[out.length - 1].fb === key) out[out.length - 1].text += ch; else out.push({ fb: key, text: ch });
    }
    return out;
  };
  const width = (r, base, size) => (r.fb ? r.fb.shim.width(r.text, size) : base.widthOfTextAtSize(r.text, size));
  return {
    drawable: (ch) => /\s/.test(ch) || std(ch) || !!fallback(ch, false),
    wrap: (base, bold = false) => ({ base, bold, encodeText: (t) => base.encodeText(t), widthOfTextAtSize: (t, size) => runs(visual(t), base, bold).reduce((a, r) => a + width(r, base, size), 0) }),
    page: (p) => {
      const draw = p.drawText.bind(p);
      p.drawText = (text, o = {}) => {
        if (!o.font?.base) return draw(text, o);
        const a = o.rotate ? (o.rotate.angle * Math.PI) / 180 : 0;
        let { x = 0, y = 0 } = o;
        for (const r of runs(o.asSeen ? text : visual(text), o.font.base, o.font.bold)) { // (right to left: as seen; asSeen: already)
          draw(r.text, { ...o, x, y, font: r.fb ? r.fb.font : o.font.base });
          const w = width(r, o.font.base, o.size || 12);
          x += w * Math.cos(a); y += w * Math.sin(a);
        }
      };
      return p;
    },
    finish: () => { for (const p of [...picks.r, ...picks.b]) p.shim.finish(p.font); },
  };
}

/** Can the fonts installed here draw every character of `text` (beyond Latin-1)? (For tests and messages.) */
export const installedCovers = (text) => [...String(text)].filter((ch) => ch.codePointAt(0) > 0xff).every((ch) => fontFiles().some(({ file }) => parsedFont(file)?.map.has(ch.codePointAt(0))));
