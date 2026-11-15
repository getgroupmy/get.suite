// Looking for QR codes in an email's pictures (inline and attached), in the browser, so Mail can warn about
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

/** The pictures to look at: inline ones in the HTML (data: addresses) and attached pictures (up to 10 MB), at most 12. */
export function picturesOf(html, attachments, urlOf) {
  const inline = [...String(html || '').matchAll(/<img\b[^>]*?\ssrc\s*=\s*["'](data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[^"']+)["']/gi)].map((m) => m[1]);
  const attached = (attachments || []).filter((a) => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.contentType || '') && (a.size || 0) <= 10 * 1024 * 1024).map(urlOf);
  return [...inline, ...attached].slice(0, 12);
}
