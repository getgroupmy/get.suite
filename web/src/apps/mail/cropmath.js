// Pure helpers for the picture editor. A crop rectangle is { x, y, w, h } as fractions (0..1)
// of the (rotated) picture, so it stays valid whatever size the preview is drawn at.

export const MIN_CROP = 0.05; // smallest crop side: 5% of the picture
export const ASPECTS = { free: null, square: 1, '4:3': 4 / 3, '16:9': 16 / 9 };
export const FULL = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Keep a rectangle inside the picture and at least MIN_CROP on each side. */
export function clampRect({ x, y, w, h }) {
  const cw = clamp(w, MIN_CROP, 1);
  const ch = clamp(h, MIN_CROP, 1);
  return { x: clamp(x, 0, 1 - cw), y: clamp(y, 0, 1 - ch), w: cw, h: ch };
}

/**
 * The largest centred rectangle with a given aspect ratio (width / height, in pixels).
 * picW / picH are the picture's pixel size, so the ratio is right for non-square pictures.
 */
export function fitAspect(aspect, picW, picH) {
  if (!aspect) return { ...FULL };
  const picRatio = picW / picH;
  let w = 1, h = 1;
  if (picRatio > aspect) w = aspect / picRatio; // picture is wider than wanted: trim the sides
  else h = picRatio / aspect; // taller: trim top and bottom
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Move the whole rectangle by (dx, dy), staying inside the picture. */
export function moveRect(r, dx, dy) {
  return { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) };
}

/**
 * Drag one edge or corner. handle is a combination of n/s/e/w ("nw", "e", ...).
 * With a fixed aspect ratio the opposite corner stays put and the shape is kept.
 */
export function resizeRect(r, handle, dx, dy, aspect = null, picW = 1, picH = 1) {
  let { x, y, w, h } = r;
  let right = x + w, bottom = y + h;
  if (handle.includes('w')) x = clamp(x + dx, 0, right - MIN_CROP);
  if (handle.includes('e')) right = clamp(right + dx, x + MIN_CROP, 1);
  if (handle.includes('n')) y = clamp(y + dy, 0, bottom - MIN_CROP);
  if (handle.includes('s')) bottom = clamp(bottom + dy, y + MIN_CROP, 1);
  w = right - x;
  h = bottom - y;
  if (aspect) {
    // Fractions -> pixels ratio: (w * picW) / (h * picH) must equal aspect.
    const k = aspect * (picH / picW); // required w / h in fraction units
    const horizontal = handle === 'e' || handle === 'w';
    const vertical = handle === 'n' || handle === 's';
    if (horizontal) h = w / k;
    else if (vertical) w = h * k;
    else if (w / h > k) w = h * k; else h = w / k;
    // Keep the opposite side fixed, then fit inside the picture.
    if (handle.includes('w')) x = right - w;
    if (handle.includes('n')) y = bottom - h;
    if (horizontal) y = r.y + (r.h - h) / 2;
    if (vertical) x = r.x + (r.w - w) / 2;
    const scale = Math.min(1, 1 / w, 1 / h);
    w *= scale; h *= scale;
  }
  return clampRect({ x, y, w, h });
}

/** Pixel rectangle to copy from a picture of size W x H. */
export function toPixels(r, W, H) {
  const sx = Math.round(r.x * W), sy = Math.round(r.y * H);
  const sw = Math.max(1, Math.min(W - sx, Math.round(r.w * W)));
  const sh = Math.max(1, Math.min(H - sy, Math.round(r.h * H)));
  return { sx, sy, sw, sh };
}

/** Size of a W x H picture after rotating by deg (multiples of 90). */
export function rotatedSize(W, H, deg) {
  return ((deg % 180) + 180) % 180 === 90 ? { w: H, h: W } : { w: W, h: H };
}

/** Output file type: keep JPEG/WebP photos as JPEG, everything else (PNG, GIF) as PNG. */
export function outputType(mime) {
  return /^image\/(jpeg|webp)$/.test(mime || '') ? { type: 'image/jpeg', ext: 'jpg', quality: 0.92 } : { type: 'image/png', ext: 'png' };
}

/** "photo.jpg" -> "photo (edited).jpg"; editing again doesn't pile up "(edited)". */
export function editedName(name, ext) {
  const base = String(name || 'picture').replace(/\.[^.]+$/, '').replace(/ \(edited\)$/, '');
  return `${base} (edited).${ext}`;
}
