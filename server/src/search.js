// Searching inside files: the words in documents, spreadsheets, presentations, text files and
// Word/Excel/PowerPoint uploads, in a full-text index (SQLite FTS5, accents ignored). A background
// indexer picks up every file whose version changed, however it changed (an editor saving,
// an upload, WebDAV, a restored version), so nothing else has to remember to update it.
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { q, FILES_DIR } from './db.js';
import { deckFromPowerPoint } from './office/powerpoint.js';
import { chipText, dateText } from './office/chiptext.js';

q("CREATE VIRTUAL TABLE IF NOT EXISTS file_text USING fts5(file_id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')").run();
q('CREATE TABLE IF NOT EXISTS file_text_state (file_id TEXT PRIMARY KEY, version INTEGER NOT NULL)').run();

const MAX_TEXT = 200_000; // characters kept per file
const MAX_READ = 20 * 1024 * 1024; // larger uploads aren't read
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-sh|sql)\b)/;
const TEXT_NAMES = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|log|ini|conf|html?|css|js|ts|py|sql|sh)$/i;

/** The text of a Docs document (TipTap JSON), one block per line. */
export function docText(doc) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'text') { out.push(n.text || ''); return; }
    if (n.type === 'image' && n.attrs?.alt) out.push(` ${n.attrs.alt} `);
    if (n.type === 'mention') out.push(`@${n.attrs?.name || ''}`);
    if (n.type === 'dropchip') out.push(` ${chipText(n.attrs)} `);
    if (n.type === 'datechip') out.push(` ${dateText(n.attrs?.date)} ${n.attrs?.date || ''} `); // found by "9 Nov" or "2026-11-09"
    if (n.type === 'math') out.push(` ${n.attrs?.latex || ''} `);
    if (n.type === 'citation') out.push(` ${n.attrs?.author || ''} ${n.attrs?.title || ''} `);
    for (const c of n.content || []) walk(c);
    if (n.type !== 'doc' && !/^(text|hardBreak)$/.test(n.type) && n.content) out.push('\n');
  };
  walk(doc);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

/** A spreadsheet's sheet names and cell entries (formulas are left out: they aren't words people look for). */
export function sheetText(json) {
  return (json?.sheets || []).map((s) => [s.name, ...Object.values(s.cells || {}).filter((v) => typeof v === 'string' && !v.startsWith('=')), ...Object.values(s.charts || {}).map((c) => c.title || ''), ...Object.values(s.notes || {})].join('\n')).join('\n');
}

/** A presentation's text boxes, slide by slide. */
export function slidesText(json) {
  return (json?.slides || []).map((s) => (s.items || []).map((it) => (it.type === 'text' ? it.text || '' : it.type === 'table' ? (it.cells || []).flat().join(' ') : '')).filter(Boolean).join('\n')).join('\n');
}

/** The words in one file (a row of `files`), or '' when there's nothing to read. */
export async function textOf(f) {
  if (f.kind === 'doc' || f.kind === 'sheet' || f.kind === 'slides') {
    let json;
    try { json = JSON.parse(f.content || '{}'); } catch { return ''; }
    return f.kind === 'doc' ? docText(json) : f.kind === 'sheet' ? sheetText(json) : slidesText(json);
  }
  if (f.kind !== 'file' || !f.storage || f.size > MAX_READ) return '';
  const file = path.join(FILES_DIR, f.storage);
  const name = f.name || '';
  try {
    if (TEXT_TYPES.test(f.mime || '') || TEXT_NAMES.test(name)) return fs.readFileSync(file, 'utf8').replace(/<[^>]+>/g, ' ');
    if (/\.docx$/i.test(name)) return (await mammoth.extractRawText({ buffer: fs.readFileSync(file) })).value;
    if (/\.xlsx$/i.test(name)) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(fs.readFileSync(file));
      const out = [];
      wb.eachSheet((ws) => { out.push(ws.name); ws.eachRow((row) => row.eachCell((c) => { const v = c.value; out.push(typeof v === 'object' && v ? (v.richText ? v.richText.map((t) => t.text).join('') : v.text ?? v.result ?? '') : String(v ?? '')); })); });
      return out.join('\n');
    }
    if (/\.pptx$/i.test(name)) return slidesText(await deckFromPowerPoint(fs.readFileSync(file), { savePicture: async () => null }));
  } catch { /* unreadable: nothing to index */ }
  return '';
}

let running = null;
/** Index the files that changed since they were last indexed (a batch at a time). Returns how many. */
export async function indexPending(limit = 40) {
  while (running) await running.catch(() => {}); // one batch at a time
  running = batch(limit);
  try { return await running; } finally { running = null; }
}
async function batch(limit) {
  {
    const rows = q(`SELECT f.id, f.kind, f.name, f.mime, f.size, f.storage, f.content, f.version FROM files f
                    LEFT JOIN file_text_state s ON s.file_id = f.id
                    WHERE f.kind != 'folder' AND (s.version IS NULL OR s.version != f.version) LIMIT ?`).all(limit);
    for (const f of rows) {
      const text = (await textOf(f)).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      q('DELETE FROM file_text WHERE file_id = ?').run(f.id);
      if (text) q('INSERT INTO file_text (file_id, body) VALUES (?, ?)').run(f.id, text);
      q('INSERT INTO file_text_state (file_id, version) VALUES (?, ?) ON CONFLICT(file_id) DO UPDATE SET version = excluded.version').run(f.id, f.version);
    }
    // Files deleted for good leave nothing behind.
    q('DELETE FROM file_text WHERE file_id NOT IN (SELECT id FROM files)').run();
    q('DELETE FROM file_text_state WHERE file_id NOT IN (SELECT id FROM files)').run();
    return rows.length;
  }
}

let timer = null;
/** Index soon (after a burst of changes settles), and keep going until everything is indexed. */
export function indexSoon(delay = 1500) {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try { if ((await indexPending()) > 0) indexSoon(200); } catch (e) { console.error('search index:', e.message); }
  }, delay);
  timer.unref?.();
}

/** Start the background indexer: right away for anything not yet indexed, then every 20 seconds. */
export function startIndexer() {
  indexSoon(500);
  setInterval(() => indexSoon(0), 20e3).unref();
}

/**
 * A full-text query from what someone typed: each word must appear (as a word or the start of
 * one), in any order. Returns null when there are no words.
 */
export function ftsQuery(input) {
  const words = String(input || '').normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return null;
  return words.slice(0, 12).map((w) => `"${w}"*`).join(' ');
}

const MARK_OPEN = '\u0001', MARK_CLOSE = '\u0002';
/** For a query: file id → a short extract around the matching words (matches between \u0001 and \u0002). */
export function contentMatches(input, limit = 300) {
  const fts = ftsQuery(input);
  if (!fts) return new Map();
  try {
    const rows = q(`SELECT file_id, snippet(file_text, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 12) AS snip FROM file_text WHERE file_text MATCH ? ORDER BY rank LIMIT ?`).all(fts, limit);
    return new Map(rows.map((r) => [r.file_id, r.snip]));
  } catch { return new Map(); } // an odd query the index can't read
}
