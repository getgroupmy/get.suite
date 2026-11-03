import crypto from 'node:crypto';

export const uid = () => crypto.randomUUID();
export const now = () => Date.now();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = (msg) => new HttpError(400, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);

export function str(v, { max = 500, required = false, name = 'value' } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${name} is required`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  const t = v.trim();
  if (required && !t) throw bad(`${name} is required`);
  if (t.length > max) throw bad(`${name} is too long`);
  return t;
}

export function int(v, name = 'value') {
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad(`${name} must be a number`);
  return Math.trunc(n);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  zip: 'application/zip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function mimeFor(name) {
  const ext = name.toLowerCase().split('.').pop();
  return MIME[ext] || 'application/octet-stream';
}
/** Types that are safe to render inline on our origin (no SVG/HTML: they can run script). */
export function isInlineSafe(mime) {
  return /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon)|video\/(mp4|webm)|audio\/.+|application\/pdf|text\/(plain|csv|markdown))$/.test(mime);
}
