// Contact photos are kept small: the middle square of the picture, at most 256 pixels across, as JPEG.
export const PHOTO_PX = 256;

/** The square to cut from a w × h picture (its middle), and the size to draw it at. */
export function squareCrop(w, h, max = PHOTO_PX) {
  const s = Math.min(w, h);
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s, out: Math.max(1, Math.min(max, s)) };
}

/** A picture file made into the small square JPEG that's uploaded (in the browser). */
export async function photoBlob(file) {
  const bmp = await createImageBitmap(file);
  const { sx, sy, s, out } = squareCrop(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = out; canvas.height = out;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out, out); // transparent pictures get a white background
  ctx.drawImage(bmp, sx, sy, s, s, 0, 0, out, out);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('That picture can’t be read'))), 'image/jpeg', 0.85));
}

export const photoUrl = (c) => (c?.photo_at ? `/api/contacts/${c.id}/photo?v=${c.photo_at}` : undefined);
