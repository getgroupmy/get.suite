// PDF tools in Drive: several PDFs and pictures combined into one PDF, and chosen pages of a PDF
// taken out into a new one (pdf-lib, all in this process). Nothing is changed in the originals.
import { PDFDocument, degrees, StandardFonts, rgb } from 'pdf-lib';

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

/** Text the standard PDF fonts can write (Latin-1); anything else becomes '?'. */
const latin = (s) => String(s ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
/**
 * The PDF with a Signatures page (or more) added at the end: for each signer their signature (drawn picture,
 * or the name in italics when typed), name, email, when and from where, and the fingerprint of the PDF signed.
 */
export async function withSignaturesPage(bytes, { title, hash, signers }) {
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold), italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  const [W, H] = [595.28, 841.89], M = 56;
  let page = null, y = 0;
  const newPage = () => {
    page = doc.addPage([W, H]); y = H - M;
    page.drawText('Signatures', { x: M, y: y - 18, size: 20, font: bold }); y -= 44;
    page.drawText(latin(title).slice(0, 90), { x: M, y, size: 11, font }); y -= 16;
    page.drawText(`Fingerprint (SHA-256) of the PDF signed: ${hash}`, { x: M, y, size: 7.5, font, color: rgb(0.35, 0.35, 0.35) }); y -= 28;
  };
  newPage();
  for (const s of signers) {
    if (y < M + 110) newPage();
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) }); y -= 14;
    if (s.image) {
      const img = await doc.embedPng(Buffer.from(String(s.image).split(',')[1] || '', 'base64'));
      const ratio = img.width / img.height, w = Math.min(ratio * 46, 220), h = w / ratio; // 46 high, or narrower when very wide
      page.drawImage(img, { x: M, y: y - h, width: w, height: h });
    } else page.drawText(latin(s.name), { x: M, y: y - 34, size: 26, font: italic, color: rgb(0.1, 0.14, 0.49) });
    y -= 60;
    page.drawText(latin(`${s.name} <${s.email}>`), { x: M, y, size: 10.5, font: bold }); y -= 14;
    page.drawText(latin(`Signed ${new Date(s.signed_at).toUTCString()}${s.ip ? ` from ${s.ip}` : ''}${s.image ? ' (drawn)' : ' (typed)'}`), { x: M, y, size: 9, font, color: rgb(0.3, 0.3, 0.3) }); y -= 24;
  }
  return doc.save();
}
