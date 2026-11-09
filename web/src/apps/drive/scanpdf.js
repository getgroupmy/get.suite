// A PDF from photos (Drive → New → Scan to PDF): each JPEG becomes a page of its own, A4 wide, as
// tall as the photo's proportions make it. JPEGs go into a PDF as they are (DCTDecode), so this is
// just the file's structure around them: no library, no re-encoding.

const enc = new TextEncoder();
const A4_WIDTH = 595.28; // points

/** pages: [{ jpeg: Uint8Array, width, height }] (pixels) → the PDF's bytes. */
export function jpegsToPdf(pages, { title = 'Scan' } = {}) {
  if (!pages.length) throw new Error('No pages');
  const parts = [];
  let length = 0;
  const offsets = [];
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };

  push('%PDF-1.4\n');
  const n = pages.length;
  // 1: catalog, 2: page list, 3: info; then per page: page, contents, image.
  const pageNum = (i) => 4 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageNum(i)} 0 R`).join(' ')}] >>`);
  const safe = String(title).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
  obj(3, `<< /Title (${safe}) /Producer (Workspace) >>`);
  pages.forEach((p, i) => {
    const w = A4_WIDTH, h = Math.round(A4_WIDTH * (p.height / p.width) * 100) / 100;
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(pageNum(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${pageNum(i) + 2} 0 R >> >> /Contents ${pageNum(i) + 1} 0 R >>`);
    obj(pageNum(i) + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(pageNum(i) + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream']);
  });
  const count = 4 + n * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}
