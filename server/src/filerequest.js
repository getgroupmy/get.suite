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
