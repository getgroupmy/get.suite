// All of a message's attachments in one .zip: each under its own name (made safe for a file system,
// and numbered when two share one: "photo.jpg", "photo (2).jpg"), stored as they came.
import JSZip from 'jszip';

/** A file name safe on any computer: no folders, no characters Windows refuses, not empty. */
export function safeName(name, fallback = 'attachment') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').split(/\s+/).filter((w) => w && !/^\.+$/.test(w)).join(' ').replace(/^\.+/, '').slice(0, 150);
  return s || fallback;
}

/** Names made unique, in order: a second "a.pdf" becomes "a (2).pdf". */
export function uniqueNames(names) {
  const used = new Set();
  return names.map((n) => {
    const dot = n.lastIndexOf('.');
    const base = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : '';
    let out = n;
    for (let k = 2; used.has(out.toLowerCase()); k++) out = `${base} (${k})${ext}`;
    used.add(out.toLowerCase());
    return out;
  });
}

/** The zip of attachments [{ filename, content }]. */
export async function attachmentsZip(list) {
  const zip = new JSZip();
  const names = uniqueNames(list.map((a, i) => safeName(a.filename, `attachment-${i + 1}`)));
  list.forEach((a, i) => zip.file(names[i], a.content, { binary: true }));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
