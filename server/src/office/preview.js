// Looking at a Word, Excel or PowerPoint file without making a copy: it's converted the way
// "Open as" converts it, but nothing is saved. Its pictures are kept in memory for a while,
// for the person who asked only, behind a random token (/api/office-preview/<token>/pictures/<n>).
import { Router } from 'express';
import crypto from 'node:crypto';
import { docFromWord } from './word.js';
import { sheetFromExcel } from './excel.js';
import { deckFromPowerPoint } from './powerpoint.js';
import { docFromMarkdown } from './markdown.js';
import { bad, notFound } from '../util.js';

export const MAX_PREVIEW = 20 * 1024 * 1024; // larger files are only downloaded
const KEEP_MS = 15 * 60e3;
const MAX_KEPT = 50;
const kept = new Map(); // token -> { userId, pictures: Map(id -> { data, mime }), at }

/** 'docx' | 'xlsx' | 'pptx' | 'md' for a file name that can be previewed this way, else null. */
export function officeKind(filename) {
  const ext = (/\.([a-z]+)$/i.exec(String(filename || '')) || [])[1]?.toLowerCase();
  return ext === 'markdown' ? 'md' : ['docx', 'xlsx', 'pptx', 'md'].includes(ext) ? ext : null;
}

function forget() {
  const old = Date.now() - KEEP_MS;
  for (const [t, v] of kept) if (v.at < old) kept.delete(t);
  while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value);
}

/**
 * The file as { kind: 'doc' | 'sheet' | 'slides', content, token } for userId. Throws a 400 for
 * files too large, of another kind, or that can't be read.
 */
export async function officePreview(buf, filename, userId) {
  const type = officeKind(filename);
  if (!type) throw bad('This kind of file has no preview');
  if (buf.length > MAX_PREVIEW) throw bad('This file is too large to preview (20 MB at most): download it instead');
  const pictures = new Map();
  const savePicture = async (_name, data, mime) => { const id = `p${pictures.size + 1}`; pictures.set(id, { data, mime }); return id; };
  let kind, content;
  try {
    if (type === 'docx') { kind = 'doc'; content = (await docFromWord(buf, { savePicture })).doc; }
    else if (type === 'md') { kind = 'doc'; content = docFromMarkdown(buf.toString('utf8')); }
    else if (type === 'xlsx') { kind = 'sheet'; content = await sheetFromExcel(buf); }
    else { kind = 'slides'; content = await deckFromPowerPoint(buf, { savePicture }); }
  } catch { throw bad("This file couldn't be read, so there's no preview: download it instead"); }
  forget();
  const token = crypto.randomBytes(18).toString('base64url');
  kept.set(token, { userId, pictures, at: Date.now() });
  return { kind, content, token };
}

/** The pictures of previews, for the person they were made for. */
export function officePreviewRoutes() {
  const r = Router();
  r.get('/:token/pictures/:pic', (req, res) => {
    const p = kept.get(req.params.token);
    const pic = p && p.userId === req.user.id && p.pictures.get(req.params.pic);
    if (!pic || !/^image\/(png|jpeg|gif|bmp|webp)$/.test(pic.mime)) throw notFound('Picture not found');
    res.set({ 'Content-Type': pic.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=900' });
    res.end(pic.data);
  });
  return r;
}
