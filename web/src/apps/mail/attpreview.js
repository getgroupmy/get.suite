// Which email attachments open in the viewer (the server shows only these: see server/src/mail/preview.js).
const KINDS = {
  picture: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'],
  pdf: ['pdf'],
  text: ['txt', 'log', 'csv', 'md'],
  video: ['mp4', 'webm'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'weba', 'opus'],
};
const BY_EXT = Object.fromEntries(Object.entries(KINDS).flatMap(([k, exts]) => exts.map((e) => [e, k])));

/** 'picture' | 'pdf' | 'text' | 'video' | 'audio', or null for attachments that only download. */
export function previewKind(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  return (m && BY_EXT[m[1].toLowerCase()]) || null;
}

/** The next attachment that can be shown, going forward (+1) or back (-1) from index i, round the list. */
export function stepPreview(attachments, i, dir) {
  const n = attachments.length;
  for (let k = 1; k <= n; k++) {
    const j = (((i + dir * k) % n) + n) % n;
    if (previewKind(attachments[j].filename)) return j;
  }
  return i;
}
