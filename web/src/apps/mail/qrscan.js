// Looking for QR codes in an email's pictures (inline and attached) and attached PDFs, in the browser, so Mail can warn about
// them: scanning one sends a phone to an address nobody checked ("quishing").
import { hasQrCode, toGray } from './qrdetect.js';

const MAX_SIDE = 900;
/** Whether the picture at this address shows a QR code (false when it can't be loaded). */
export async function pictureHasQr(src) {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return hasQrCode(toGray(ctx.getImageData(0, 0, w, h).data, w, h), w, h);
  } catch { return false; }
}

/**
 * Whether a PDF (at this address) shows a QR code on one of its first 3 pages: each page drawn about
 * 1,000 pixels wide, as pictures are. pdf.js is loaded only when there's a PDF to look at. False when it
 * can't be read (a password, damaged).
 */
export async function pdfHasQr(url) {
  let doc = null;
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    doc = await pdfjs.getDocument({ url, withCredentials: true, isEvalSupported: false }).promise;
    for (let n = 1; n <= Math.min(3, doc.numPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const v = page.getViewport({ scale: Math.min(3, 1000 / base.width) });
      const c = document.createElement('canvas');
      c.width = Math.round(v.width); c.height = Math.round(v.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: v }).promise;
      if (hasQrCode(toGray(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height), c.width, c.height)) return true;
    }
    return false;
  } catch { return false; } finally { doc?.destroy?.(); }
}

/** The PDFs to look at: attached ones up to 10 MB, at most 3. */
export const pdfsOf = (attachments, urlOf) => (attachments || []).filter((a) => /^application\/pdf$/i.test(a.contentType || '') || /\.pdf$/i.test(a.filename || '')).filter((a) => (a.size || 0) <= 10 * 1024 * 1024).slice(0, 3).map(urlOf);

/** The pictures to look at: inline ones in the HTML (data: addresses) and attached pictures (up to 10 MB), at most 12. */
export function picturesOf(html, attachments, urlOf) {
  const inline = [...String(html || '').matchAll(/<img\b[^>]*?\ssrc\s*=\s*["'](data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[^"']+)["']/gi)].map((m) => m[1]);
  const attached = (attachments || []).filter((a) => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.contentType || '') && (a.size || 0) <= 10 * 1024 * 1024).map(urlOf);
  return [...inline, ...attached].slice(0, 12);
}
