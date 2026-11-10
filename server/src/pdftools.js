// PDF tools in Drive: several PDFs and pictures combined into one PDF, and chosen pages of a PDF
// taken out into a new one (pdf-lib, all in this process). Nothing is changed in the originals.
import { PDFDocument, degrees } from 'pdf-lib';

export const MAX_PAGES = 2000;

/** "1-3, 5, 8-" → page indexes (0-based, in the order given) of a PDF with `count` pages, or an error message. */
export function parsePages(spec, count) {
  const out = [];
  const text = String(spec || '').replace(/\s+/g, '');
  if (!text) return { error: 'Say which pages, like 1-3, 5' };
  for (const part of text.split(',')) {
    const m = /^(\d+)?(-)?(\d+)?$/.exec(part);
    if (!m || (!m[1] && !m[3])) return { error: `“${part}” isn’t a page or a range of pages` };
    const from = m[1] ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] ? Number(m[3]) : count) : from;
    if (from < 1 || to > count || from > to) return { error: `This PDF has ${count} page${count === 1 ? '' : 's'}: ${part} isn’t in it` };
    for (let p = from; p <= to; p++) out.push(p - 1);
    if (out.length > MAX_PAGES) return { error: `At most ${MAX_PAGES} pages` };
  }
  return { pages: out };
}

const A4 = [595.28, 841.89];
/**
 * One PDF from parts, in order: [{ bytes, type: 'pdf' | 'png' | 'jpg', name }]. Pictures get a page each, A4
 * (landscape for wide ones), fitted with a margin. Throws { message } naming a part that can't be read.
 */
export async function combine(parts) {
  const out = await PDFDocument.create();
  for (const p of parts) {
    try {
      if (p.type === 'pdf') {
        const src = await PDFDocument.load(p.bytes, { ignoreEncryption: false });
        if (out.getPageCount() + src.getPageCount() > MAX_PAGES) throw new Error(`At most ${MAX_PAGES} pages`);
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      } else {
        const img = p.type === 'png' ? await out.embedPng(p.bytes) : await out.embedJpg(p.bytes);
        const wide = img.width > img.height;
        const [w, h] = wide ? [A4[1], A4[0]] : A4;
        const margin = 36, scale = Math.min((w - 2 * margin) / img.width, (h - 2 * margin) / img.height, 1);
        const page = out.addPage([w, h]);
        page.drawImage(img, { x: (w - img.width * scale) / 2, y: (h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
      }
    } catch (e) {
      if (/At most/.test(e.message)) throw e;
      throw new Error(/encrypt/i.test(e.message) ? `“${p.name}” is password-protected` : `“${p.name}” couldn’t be read`);
    }
  }
  return out.save();
}

/** A new PDF of some pages of one (indexes as parsePages gives), optionally each turned by `turn` degrees. */
export async function extract(bytes, pages, turn = 0) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(src, pages)) {
    if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
    out.addPage(page);
  }
  return out.save();
}

export const pageCount = async (bytes) => (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
/** Which kind a Drive file is for these tools: 'pdf', 'png', 'jpg' or null. */
export function typeOf(f) {
  const n = String(f.name || '').toLowerCase(), m = String(f.mime || '').toLowerCase();
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (m === 'image/png' || n.endsWith('.png')) return 'png';
  if (m === 'image/jpeg' || /\.jpe?g$/.test(n)) return 'jpg';
  return null;
}

/**
 * Stamp pictures onto pages (fill & sign): items [{ page (0-based), x, y, w, h (fractions of the page as seen,
 * from its top left), png (bytes) }]. Pages turned by the PDF itself (/Rotate) are handled too.
 */
export async function stamp(bytes, items) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  for (const it of items) {
    const page = pages[it.page];
    if (!page) throw new Error(`There is no page ${it.page + 1}`);
    const img = await doc.embedPng(it.png);
    const { width: W, height: H } = page.getSize(); // unrotated
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    const [dw, dh] = rot % 180 ? [H, W] : [W, H]; // the page as it's seen
    const x = it.x * dw, y = it.y * dh, w = it.w * dw, h = it.h * dh; // seen from the top left
    // Where the picture's bottom-left corner (as seen) lands in the page's own coordinates, and its turn.
    let px, py;
    if (rot === 0) { px = x; py = H - y - h; }
    else if (rot === 90) { px = y + h; py = x; }
    else if (rot === 180) { px = W - x; py = y + h; }
    else { px = W - y - h; py = H - x; }
    page.drawImage(img, { x: px, y: py, width: w, height: h, rotate: degrees(rot) });
  }
  return doc.save();
}

/** A new PDF with pages picked, in order, each turned on its own: [{ page (0-based), rotate (0, 90, 180, 270) }]. */
export async function organize(bytes, list) {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, list.map((x) => x.page));
  copied.forEach((page, i) => {
    if (list[i].rotate) page.setRotation(degrees((page.getRotation().angle + list[i].rotate) % 360));
    out.addPage(page);
  });
  return out.save();
}
