// Zip files: what's inside one (Drive previews and email attachments), and unpacking one into a
// Drive folder. Zips come from anyone, so names are cleaned (no "../", absolute paths or odd
// characters), junk like __MACOSX is left out, and the number of files and their unpacked size
// are capped, counted as they're unpacked rather than trusting what the zip says.
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { bad, mimeFor, uid } from './util.js';
import { FILES_DIR } from './db.js';

export const MAX_ZIP = 500 * 1024 * 1024; // zips larger than this aren't opened
export const MAX_ENTRIES = 5000;
export const MAX_UNPACKED = 2 * 1024 * 1024 * 1024;
const LISTED = 2000;
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

/** A path inside a zip as clean folder and file names, or null for one to leave out. */
export function cleanZipPath(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/')
    .map((s) => s.replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, 255))
    .filter((s) => s && s !== '.' && s !== '..');
  if (!parts.length || JUNK.test(parts.join('/'))) return null;
  return parts;
}

async function open(buf) {
  if (buf.length > MAX_ZIP) throw bad('This zip file is too large to open here (500 MB at most): download it instead');
  try { return await JSZip.loadAsync(buf); } catch (e) {
    throw bad(/encrypt/i.test(e.message) ? 'This zip file is password-protected: download it to open it' : "This zip file couldn't be read");
  }
}

// What the zip says a file unpacks to (checked again while unpacking).
const declared = (f) => Number(f._data?.uncompressedSize) || 0;

/** { entries: [{ path, size, dir }], files, folders, size, more } with folders implied by paths included. */
export async function zipEntries(buf) {
  const zip = await open(buf);
  const seen = new Map();
  let files = 0, size = 0;
  zip.forEach((p, f) => {
    const parts = cleanZipPath(p);
    if (!parts) return;
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!seen.has(d)) seen.set(d, { path: d, size: 0, dir: true }); }
    const key = parts.join('/');
    if (f.dir) { if (!seen.has(key)) seen.set(key, { path: key, size: 0, dir: true }); return; }
    files++; size += declared(f);
    seen.set(key, { path: key, size: declared(f), dir: false });
  });
  const all = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { entries: all.slice(0, LISTED), files, folders: all.filter((e) => e.dir).length, size, more: Math.max(0, all.length - LISTED) };
}

/**
 * Unpack into a new folder: makeFolder(name, parentId) and makeFile({ name, parentId, size, storage, mime })
 * give ids (the caller's Drive rules), checkSpace(bytes) throws when there isn't room. Returns { files, folders }.
 */
export async function extractZip(buf, { makeFolder, makeFile, checkSpace, rootName, parentId }) {
  const zip = await open(buf);
  const items = [];
  zip.forEach((p, f) => { const parts = cleanZipPath(p); if (parts) items.push({ parts, f }); });
  const files = items.filter((i) => !i.f.dir);
  if (files.length > MAX_ENTRIES) throw bad(`This zip has ${files.length} files: at most ${MAX_ENTRIES} can be unpacked here`);
  const total = files.reduce((n, i) => n + declared(i.f), 0);
  if (total > MAX_UNPACKED) throw bad('This zip unpacks to more than 2 GB: download it instead');
  checkSpace(total);
  const root = makeFolder(rootName, parentId);
  const folders = new Map([['', root]]);
  const folderFor = (parts) => {
    let at = '';
    for (const name of parts) {
      const next = at ? `${at}/${name}` : name;
      if (!folders.has(next)) folders.set(next, makeFolder(name, folders.get(at)));
      at = next;
    }
    return folders.get(at);
  };
  for (const { parts } of items.filter((i) => i.f.dir)) folderFor(parts);
  let unpacked = 0;
  const written = [];
  try {
    for (const { parts, f } of files) {
      let data;
      try { data = await f.async('nodebuffer'); } catch (e) {
        throw bad(/size mismatch/i.test(e.message) ? 'This zip unpacks to more than it says it does, so it was not unpacked' : `“${parts.join('/')}” in this zip couldn't be unpacked (the zip may be damaged), so nothing was unpacked`);
      }
      unpacked += data.length;
      if (unpacked > MAX_UNPACKED || unpacked > total + 1024 * 1024 + total * 0.01) throw bad('This zip unpacks to more than it says it does, so it was not unpacked');
      const storage = uid();
      fs.writeFileSync(path.join(FILES_DIR, storage), data);
      written.push(storage);
      const name = parts[parts.length - 1];
      makeFile({ name, parentId: folderFor(parts.slice(0, -1)), size: data.length, storage, mime: mimeFor(name) });
    }
  } catch (e) { e.root = root; e.written = written; throw e; }
  return { id: root, files: files.length, folders: folders.size - 1 };
}
