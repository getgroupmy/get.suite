// File requests (links that only take files in): what they accept. The owner can limit them to some kinds of
// file (PDFs, pictures, documents…), to a size per file, and leave a note for the people sending. Kinds go by
// the file's name (its extension), which is also what decides how Drive opens it.
import { bad } from './util.js';

export const REQUEST_KINDS = {
  pdf: { label: 'PDFs', ext: ['pdf'] },
  pictures: { label: 'Pictures', ext: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp'] },
  documents: { label: 'Documents', ext: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'] },
  spreadsheets: { label: 'Spreadsheets', ext: ['xls', 'xlsx', 'ods', 'csv', 'numbers'] },
  presentations: { label: 'Presentations', ext: ['ppt', 'pptx', 'odp', 'key'] },
  videos: { label: 'Videos', ext: ['mp4', 'mov', 'm4v', 'webm', 'avi'] },
  zip: { label: 'Zip files', ext: ['zip'] },
};
export const MAX_NOTE = 500;

/**
 * What a new or changed file request asks for, checked: { accept: 'pdf,pictures' | null, max_mb: n | null,
 * note: text | null }. `uploadMb` is the server's own limit per file (a request can only be stricter).
 */
export function cleanRequest(b, uploadMb) {
  const out = {};
  if ('accept' in b) {
    const list = b.accept == null ? [] : Array.isArray(b.accept) ? b.accept : [b.accept];
    const kinds = [...new Set(list.map((k) => String(k).toLowerCase()))];
    const unknown = kinds.find((k) => !REQUEST_KINDS[k]);
    if (unknown) throw bad(`Unknown kind of file: ${unknown}`);
    out.accept = kinds.length ? Object.keys(REQUEST_KINDS).filter((k) => kinds.includes(k)).join(',') : null;
  }
  if ('max_mb' in b) {
    if (b.max_mb == null || b.max_mb === '') out.max_mb = null;
    else {
      const n = Number(b.max_mb);
      if (!Number.isInteger(n) || n < 1) throw bad('A size limit is a whole number of MB, at least 1');
      if (n > uploadMb) throw bad(`Files can be at most ${uploadMb} MB on this server`);
      out.max_mb = n;
    }
  }
  if ('note' in b) {
    const note = String(b.note ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
    if (note.length > MAX_NOTE) throw bad(`A note can be at most ${MAX_NOTE} characters`);
    out.note = note || null;
  }
  return out;
}

const extOf = (name) => (/\.([a-z0-9]{1,8})$/i.exec(String(name || ''))?.[1] || '').toLowerCase();

/** Whether a file of this name may be sent through a request accepting `accept` ('pdf,pictures', or null for any). */
export function accepts(accept, name) {
  if (!accept) return true;
  const ext = extOf(name);
  return accept.split(',').some((k) => REQUEST_KINDS[k]?.ext.includes(ext));
}

/** "PDFs or pictures", for messages and the page people send from. */
export function acceptText(accept) {
  const labels = (accept || '').split(',').filter((k) => REQUEST_KINDS[k]).map((k) => REQUEST_KINDS[k].label);
  if (!labels.length) return 'any file';
  const low = labels.map((l, i) => (i ? l.toLowerCase() : l));
  return low.length === 1 ? low[0] : `${low.slice(0, -1).join(', ')} or ${low[low.length - 1]}`;
}

/** The extensions a browser's file picker can be limited to (".pdf,.jpg,…"), or '' for any. */
export const acceptAttr = (accept) => (accept || '').split(',').flatMap((k) => REQUEST_KINDS[k]?.ext || []).map((e) => `.${e}`).join(',');

// What a file of each extension starts with, so a renamed file (a program called receipt.pdf) is caught.
const PK = (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7); // zip (Office, OpenDocument, iWork)
const OLE = (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])); // old Office
const ascii = (b, at, s) => b.subarray(at, at + s.length).toString('latin1') === s;
const text = (b) => !b.includes(0); // plain text: no NUL bytes in what was read
const ftyp = (brands) => (b) => ascii(b, 4, 'ftyp') && (!brands || brands.includes(b.subarray(8, 12).toString('latin1')));
const SIGNS = {
  pdf: (b) => b.subarray(0, 1024).includes(Buffer.from('%PDF-')),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, png: (b) => ascii(b, 0, '\x89PNG'), gif: (b) => ascii(b, 0, 'GIF8'),
  webp: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'), bmp: (b) => ascii(b, 0, 'BM'),
  tif: (b) => ascii(b, 0, 'II*\x00') || ascii(b, 0, 'MM\x00*'),
  heic: ftyp(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis']),
  docx: PK, xlsx: PK, pptx: PK, odt: PK, ods: PK, odp: PK, pages: PK, numbers: PK, key: PK, zip: PK,
  doc: OLE, xls: OLE, ppt: OLE, rtf: (b) => ascii(b, 0, '{\\rtf'), txt: text, md: text, csv: text,
  mp4: ftyp(), mov: (b) => ftyp()(b) || ['moov', 'mdat', 'wide', 'free'].some((t) => ascii(b, 4, t)), m4v: ftyp(),
  webm: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), avi: (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'AVI '),
};
Object.assign(SIGNS, { jpeg: SIGNS.jpg, tiff: SIGNS.tif, heif: SIGNS.heic });

/** Whether a file's first bytes (`head`, a Buffer of up to 4 KB) are what its name's extension says it is. */
export function looksLike(name, head) {
  const sign = SIGNS[extOf(name)];
  return !sign || (head.length > 0 && sign(head));
}
