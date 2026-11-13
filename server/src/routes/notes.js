// Notes: quick notes and checklists on coloured cards. Pin the important ones, give them labels, archive
// what's done with, and share a note with colleagues to keep it together (everyone it's shared with can
// change it; only its owner can delete it). Mounted at /api/notes.
import { nextRemind, REPEATS } from '../noterepeat.js';
import { zoneOrUtc } from '../ics.js';
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { sendTo } from '../hub.js';
import { notesFromEnex, noteFromHtml } from '../evernote.js';
import { notify as bell } from '../notifications.js';
import { insertFile, receiveUpload } from './files.js';
import fs from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from '../db.js';
import { checkQuota } from '../tenancy.js';
import { myFirstList, addTasks } from './tasks.js';

q(`CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  items TEXT,                    -- a checklist: JSON [{ id, text, done }], or null for plain text
  color TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]',
  position REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
)`).run();
q(`CREATE TABLE IF NOT EXISTS note_shares (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, user_id)
)`).run();
q('CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner_id)').run();
// Each person's own order of the cards (dragged into place); notes they haven't moved keep the note's own position.
q(`CREATE TABLE IF NOT EXISTS note_order (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  PRIMARY KEY (user_id, note_id)
)`).run();
/** One above the highest card this person sees, so a new note goes first. */
const topFor = (userId) => (q(`SELECT MAX(COALESCE(o.position, n.position)) AS p FROM notes n LEFT JOIN note_order o ON o.note_id = n.id AND o.user_id = ?
                               WHERE n.owner_id = ? OR n.id IN (SELECT note_id FROM note_shares WHERE user_id = ?)`).get(userId, userId, userId).p ?? 0) + 1;
if (!q('PRAGMA table_info(notes)').all().some((c) => c.name === 'remind_at')) q('ALTER TABLE notes ADD COLUMN remind_at INTEGER').run(); // a reminder, for everyone on the note
// A reminder can repeat (daily, weekdays, weekly, monthly) at the same time in the time zone of whoever set it.
for (const col of ['remind_repeat', 'remind_tz']) if (!q('PRAGMA table_info(notes)').all().some((c) => c.name === col)) q(`ALTER TABLE notes ADD COLUMN ${col} TEXT`).run();
// remind_reset: when a repeating reminder goes off, untick the checklist so it starts again.
if (!q('PRAGMA table_info(notes)').all().some((c) => c.name === 'remind_reset')) q('ALTER TABLE notes ADD COLUMN remind_reset INTEGER NOT NULL DEFAULT 0').run();
// A shared note's own Chat channel (Chat with people it's shared with), once made.
if (!q('PRAGMA table_info(notes)').all().some((c) => c.name === 'chat_channel_id')) q('ALTER TABLE notes ADD COLUMN chat_channel_id TEXT').run();

// Pictures on a note (shown at the top of the card), stored like Drive files but not listed in Drive.
q(`CREATE TABLE IF NOT EXISTS note_pictures (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  storage TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  added_by TEXT,
  created_at INTEGER NOT NULL
)`).run();
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']; // not SVG: it can carry scripts
const MAX_PICTURES = 10, MAX_PICTURE_BYTES = 10 * 1024 * 1024;
const picturesOf = (noteId) => q('SELECT id, mime, size FROM note_pictures WHERE note_id = ? ORDER BY created_at').all(noteId);
/** Remove a note's picture files from disk (before the note or picture rows go). */
function dropPictureFiles(rows) { for (const p of rows) fs.rm(path.join(FILES_DIR, p.storage), { force: true }, () => {}); }

export const COLORS = ['#faafa8', '#f39f76', '#fff8b8', '#e2f6d3', '#b4ddd3', '#d4e4ed', '#aeccdc', '#d3bfdb', '#f6e2dd', '#e9e3d4', '#efeff1'];
const MAX_NOTES = 2000, MAX_ITEMS = 200, MAX_LABELS = 10;
q(`CREATE TABLE IF NOT EXISTS note_label_colors (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  PRIMARY KEY (user_id, label)
)`).run();
export const LABEL_COLORS = ['#d93025', '#e8710a', '#f9ab00', '#188038', '#12b5cb', '#1a73e8', '#9334e6', '#e52592', '#5f6368'];

/** Tidy a checklist from the client. */
/** Google Keep's colours (its Takeout names them) → ours: the same palette. */
const KEEP_COLORS = { RED: '#faafa8', ORANGE: '#f39f76', YELLOW: '#fff8b8', GREEN: '#e2f6d3', TEAL: '#b4ddd3', BLUE: '#d4e4ed', CERULEAN: '#aeccdc', DARK_BLUE: '#aeccdc', PURPLE: '#d3bfdb', PINK: '#f6e2dd', BROWN: '#e9e3d4', GRAY: '#efeff1' };
/**
 * A note from Google Keep (one of the .json files in Google Takeout's Keep folder) as one of ours:
 * { title, body, items, color, pinned, archived, labels, created_at, updated_at }, or null for one in Keep's trash
 * or with nothing in it.
 */
export function keepNote(k, { hasPictures = false } = {}) {
  if (!k || typeof k !== 'object' || k.isTrashed) return null;
  const items = Array.isArray(k.listContent) ? k.listContent.map((x) => ({ text: String(x?.text ?? ''), done: !!x?.isChecked })) : null;
  const title = String(k.title ?? '').slice(0, 300), body = String(k.textContent ?? '').slice(0, 20000);
  if (!title.trim() && !body.trim() && !(items || []).some((i) => i.text.trim()) && !hasPictures) return null; // a photo-only note is still a note
  const usec = (v) => (Number(v) > 0 ? Math.round(Number(v) / 1000) : null);
  return {
    title, body: items ? '' : body, items, color: KEEP_COLORS[String(k.color || '').toUpperCase()] || null,
    pinned: !!k.isPinned && !k.isArchived, archived: !!k.isArchived,
    labels: (Array.isArray(k.labels) ? k.labels : []).map((l) => String(l?.name ?? l ?? '')).filter(Boolean),
    created_at: usec(k.createdTimestampUsec), updated_at: usec(k.userEditedTimestampUsec),
  };
}

export function cleanItems(list) {
  if (list === null) return null;
  if (!Array.isArray(list)) throw bad('items must be a list');
  return list.slice(0, MAX_ITEMS).map((it, i) => ({
    id: typeof it?.id === 'string' && /^[\w-]{1,40}$/.test(it.id) ? it.id : uid().slice(0, 12),
    text: String(it?.text ?? '').slice(0, 1000),
    done: !!it?.done,
    ...(it?.indent && i > 0 && { indent: 1 }), // a sub-item of the item above (one level)
  }));
}
/**
 * Text → checklist (Show tick boxes): a line per item, blank lines left out. Bullets ("- ", "* ", "• ", "1. ")
 * and "[ ]" go; "[x]" or "✓ " makes it ticked; an indented line is a sub-item of the one above.
 */
export function textToItems(body) {
  const out = [];
  for (const raw of String(body || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = /^(\t| {2,})/.test(raw) && out.length > 0;
    let t = raw.trim().replace(/^([-*•]|\d+[.)])\s+/, '');
    let done = false;
    const box = /^\[( |x|X)\]\s*/.exec(t);
    if (box) { done = box[1] !== ' '; t = t.slice(box[0].length); } else if (/^✓\s*/.test(t)) { done = true; t = t.replace(/^✓\s*/, ''); }
    out.push({ id: uid().slice(0, 12), text: t.slice(0, 1000), done, ...(indent && { indent: 1 }) });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}
/** A note as Markdown: its title as a heading, then its text, or its checklist as "- [x]" lines (sub-items indented), then labels. */
export function noteMarkdown(n) {
  const lines = [];
  if (n.title) lines.push(`# ${n.title}`, '');
  if (n.items) for (const it of n.items) lines.push(`${it.indent ? '  ' : ''}- [${it.done ? 'x' : ' '}] ${it.text}`);
  else if (n.body) lines.push(n.body);
  if (n.labels?.length) lines.push('', n.labels.map((l) => `#${l.replace(/\s+/g, '-')}`).join(' '));
  return `${lines.join('\n').trim()}\n`;
}
/**
 * A note from a Markdown or text file (as Download (.md) writes them, and as other notes apps export):
 * a first "# heading" is the title (else the file's name), a last line of only #tags gives labels, and
 * when every other line is a "- [ ]" / "- [x]" item the note is a checklist (indented items are sub-items).
 */
export function noteFromMarkdown(text, fileName = '') {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/^\ufeff/, '').split('\n');
  let title = '';
  while (lines.length && !lines[0].trim()) lines.shift();
  if (/^#\s+\S/.test(lines[0] || '')) title = lines.shift().replace(/^#\s+/, '').trim();
  else title = String(fileName).replace(/\.(md|markdown|txt)$/i, '').trim();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let labels = [];
  const last = (lines[lines.length - 1] || '').trim();
  if (/^(#[\p{L}\p{N}_-]+\s*)+$/u.test(last)) { labels = last.split(/\s+/).map((t) => t.slice(1).replace(/-/g, ' ')); lines.pop(); }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const task = /^(\s*)[-*]\s+\[([ xX])\]\s?(.*)$/;
  const filled = lines.filter((l) => l.trim());
  if (filled.length && filled.every((l) => task.test(l))) {
    const items = filled.map((l, i) => { const [, ind, mark, t] = task.exec(l); return { text: t.trim(), done: mark !== ' ', ...(ind.length >= 2 && i > 0 && { indent: 1 }) }; });
    return { title: title.slice(0, 300), body: '', items: cleanItems(items), labels: cleanLabels(labels) };
  }
  return { title: title.slice(0, 300), body: lines.join('\n').slice(0, 20000), items: null, labels: cleanLabels(labels) };
}
/** Checklist → text (Hide tick boxes): a line per item, ticked ones as "✓ …", sub-items indented. */
export const itemsToText = (items) => (items || []).map((i) => `${i.indent ? '  ' : ''}${i.done ? '✓ ' : ''}${i.text}`).join('\n');

/** A checklist as a document's tick boxes: sub-items as a list inside the item above. */
export function taskItems(items, para) {
  const out = [];
  for (const i of items) {
    const node = { type: 'taskItem', attrs: { checked: !!i.done }, content: [para(i.text)] };
    const last = out[out.length - 1];
    if (i.indent && last) { if (last.content.length < 2) last.content.push({ type: 'taskList', content: [] }); last.content[1].content.push(node); } else out.push(node);
  }
  return out;
}

/**
 * A checklist's unticked items as tasks: a main item with its unticked sub-items as the task's steps;
 * an unticked sub-item of a ticked item is a task of its own.
 */
export function tasksFromItems(items) {
  const out = [];
  let parent = null; // the task being filled with steps
  for (const it of items) {
    const text = String(it.text || '').trim();
    if (!it.indent) { parent = !it.done && text ? { title: text, steps: [] } : null; if (parent) out.push(parent); continue; }
    if (it.done || !text) continue;
    if (parent) parent.steps.push(text); else out.push({ title: text, steps: [] });
  }
  return out.map((t) => (t.steps.length ? t : t.title));
}
export function cleanLabels(list) {
  if (!Array.isArray(list)) throw bad('labels must be a list');
  return [...new Set(list.map((l) => String(l ?? '').trim().slice(0, 40)).filter(Boolean))].slice(0, MAX_LABELS);
}

// How each person shows their notes: cards in a grid, or one column (a list).
q(`CREATE TABLE IF NOT EXISTS note_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  view TEXT NOT NULL DEFAULT 'grid'
)`).run();
export const NOTE_VIEWS = ['grid', 'list'];
// And in what order: your own (dragged), last edited, newest, or by title.
export const NOTE_SORTS = ['mine', 'edited', 'created', 'title'];
if (!q('PRAGMA table_info(note_prefs)').all().some((c) => c.name === 'sort')) q("ALTER TABLE note_prefs ADD COLUMN sort TEXT NOT NULL DEFAULT 'mine'").run();

// Trash: a deleted note waits here for its owner (restore it, or delete it for good) for TRASH_DAYS.
if (!q('PRAGMA table_info(notes)').all().some((c) => c.name === 'trashed_at')) q('ALTER TABLE notes ADD COLUMN trashed_at INTEGER').run();
export const TRASH_DAYS = 7;

const team = (n) => [n.owner_id, ...q('SELECT user_id FROM note_shares WHERE note_id = ?').all(n.id).map((s) => s.user_id)];
function shape(n, me) {
  return {
    id: n.id, title: n.title, body: n.body, items: n.items ? JSON.parse(n.items) : null, color: n.color, pinned: !!n.pinned, archived: !!n.archived, trashed_at: n.trashed_at ?? null,
    labels: JSON.parse(n.labels || '[]'), remind_at: n.remind_at ?? null, remind_repeat: n.remind_repeat || null, remind_reset: !!n.remind_reset, pictures: picturesOf(n.id).map((p) => p.id), position: n.position, created_at: n.created_at, updated_at: n.updated_at, mine: n.owner_id === me,
    owner: q('SELECT id, name, username FROM users WHERE id = ?').get(n.owner_id),
    shared: q(`SELECT u.id, u.name, u.username FROM note_shares s JOIN users u ON u.id = s.user_id WHERE s.note_id = ? ORDER BY u.name`).all(n.id),
  };
}
/**
 * Notes as files for a .zip: each as "<title>.md" (repeats numbered), its pictures in "<title> files/picture-1.jpg" beside it,
 * shown in the Markdown. Used by Download (.zip) and by Download your data.
 */
export async function notesZipEntries(notes) {
  const { uniqueNames, safeName } = await import('../mail/attzip.js');
  const names = uniqueNames(notes.map((n) => `${safeName(n.title, 'Note').slice(0, 80)}.md`));
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const out = [];
  notes.forEach((n, i) => {
    const dir = `${names[i].replace(/\.md$/, '')} files`;
    const pics = q('SELECT storage, mime FROM note_pictures WHERE note_id = ? ORDER BY created_at').all(n.id).flatMap((p, k) => {
      try { return [{ path: `${dir}/picture-${k + 1}.${EXT[p.mime] || 'img'}`, data: fs.readFileSync(path.join(FILES_DIR, p.storage)) }]; } catch { return []; }
    });
    let md = noteMarkdown({ title: n.title, body: n.body, items: n.items ? JSON.parse(n.items) : null, labels: JSON.parse(n.labels || '[]') });
    if (pics.length) md = `${md.replace(/\s*$/, '')}\n\n${pics.map((p) => `![](${encodeURI(p.path)})`).join('\n')}\n`;
    out.push({ path: names[i], data: md }, ...pics);
  });
  return out;
}

function load(id, user) {
  const n = q('SELECT * FROM notes WHERE id = ?').get(String(id));
  if (!n || (n.owner_id !== user.id && (n.trashed_at || !q('SELECT 1 FROM note_shares WHERE note_id = ? AND user_id = ?').get(n.id, user.id)))) throw notFound('Note not found');
  return n;
}
const tell = (n) => sendTo(team(n), { type: 'notes-changed' });

// Version history: what a note said before, kept when someone else edits it, or after 10 minutes'
// quiet (so a burst of typing is one version). At most MAX_VERSIONS per note; restoring keeps the
// current text as a version too.
q(`CREATE TABLE IF NOT EXISTS note_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  items TEXT,
  saved_at INTEGER NOT NULL,
  saved_by TEXT
)`).run();
export const MAX_VERSIONS = 50;
export const QUIET_MS = 10 * 60e3;
const sameContent = (a, b) => (a.title || '') === (b.title || '') && (a.body || '') === (b.body || '') && (a.items || null) === (b.items || null);
/** Keep the note as it is now as a version (unless the newest version is the same). */
function keepVersion(n) {
  if (!n.title && !n.body && !(n.items && JSON.parse(n.items).length)) return; // nothing written yet
  const last = q('SELECT * FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC LIMIT 1').get(n.id);
  if (last && sameContent(last, n)) return;
  q('INSERT INTO note_versions (id, note_id, title, body, items, saved_at, saved_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid(), n.id, n.title || '', n.body || '', n.items || null, n.updated_at, n.updated_by || n.owner_id);
  q('DELETE FROM note_versions WHERE note_id = ? AND id NOT IN (SELECT id FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC LIMIT ?)').run(n.id, n.id, MAX_VERSIONS);
}
/** Before an edit by `userId` changes the text: keep what was there, when it's someone else's or has rested a while. */
function versionBefore(n, userId, set, t = now()) {
  const changes = ['title', 'body', 'items'].some((k) => set[k] !== undefined && (set[k] ?? null) !== (n[k] ?? null));
  if (!changes) return;
  const last = q('SELECT saved_at FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC LIMIT 1').get(n.id);
  if ((n.updated_by || n.owner_id) !== userId || t - n.updated_at >= QUIET_MS || !last) keepVersion(n);
}

/** Send the reminders that are due (to everyone on each note), then clear them (or move a repeating one on). */
export function remindNotesDue(at = now()) {
  const due = q('SELECT * FROM notes WHERE remind_at IS NOT NULL AND remind_at <= ? AND trashed_at IS NULL ORDER BY remind_at LIMIT 100').all(at);
  for (const n of due) {
    // A repeating one moves on to its next time; the others are done.
    const next = n.remind_repeat ? nextRemind(n.remind_at, n.remind_repeat, n.remind_tz, at) : null;
    q('UPDATE notes SET remind_at = ?, remind_repeat = ? WHERE id = ?').run(next, next ? n.remind_repeat : null, n.id);
    // A checklist that starts again each time: everything unticked (what it was is kept in its version history).
    if (next && n.remind_reset && n.items) {
      const items = JSON.parse(n.items);
      if (items.some((i) => i.done)) {
        keepVersion(n);
        q('UPDATE notes SET items = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(items.map((i) => ({ ...i, done: false }))), at, n.id);
      }
    }
    const cur = q('SELECT * FROM notes WHERE id = ?').get(n.id); // as it is now (a reset checklist: all to do)
    const items = cur.items ? JSON.parse(cur.items).filter((i) => !i.done).map((i) => `☐ ${i.text}`).join('\n') : '';
    bell(team(cur), { kind: 'note', title: `Reminder: ${cur.title || (cur.body || '').split('\n')[0].slice(0, 80) || 'a note'}`, body: (cur.title ? cur.body || items : items).slice(0, 200) || null, link: '/notes', actor: null });
    tell(cur);
  }
  return due.length;
}
/** Notes in the trash longer than TRASH_DAYS go for good (with their pictures). */
export function purgeTrashedNotes(at = now()) {
  const old = q('SELECT id FROM notes WHERE trashed_at IS NOT NULL AND trashed_at <= ?').all(at - TRASH_DAYS * 864e5);
  for (const n of old) { dropPictureFiles(q('SELECT storage FROM note_pictures WHERE note_id = ?').all(n.id)); q('DELETE FROM notes WHERE id = ?').run(n.id); }
  return old.length;
}
export function startNotesScheduler() {
  setInterval(() => { try { remindNotesDue(); } catch (e) { console.error('[notes] reminders:', e.message); } }, 15e3).unref();
  setInterval(() => { try { purgeTrashedNotes(); } catch (e) { console.error('[notes] trash:', e.message); } }, 36e5).unref();
}

/** Notes from files ({ files: [{ name, text } or { name, base64 } for a .zip] }): { added, skipped } */
export async function importNotes(user, body) {
  // A .zip (sent as base64: a downloaded .zip of notes, or Google Keep's Takeout) is opened here: the note files in it,
  // in any folder, are imported as if chosen one by one.
  const files = [];
  for (const f of Array.isArray(body?.files) ? body.files : []) {
    if (!/\.zip$/i.test(String(f?.name || '')) || typeof f?.base64 !== 'string') { files.push(f); continue; }
    let zip;
    try { zip = await (await import('jszip')).default.loadAsync(Buffer.from(f.base64, 'base64')); } catch { throw bad(`“${f.name}” can’t be opened`); }
    let inside = Object.values(zip.files).filter((x) => !x.dir && /\.(md|markdown|txt|json|enex|html?)$/i.test(x.name) && !/(^|\/)(__MACOSX|\.)/.test(x.name)
      && !/(^|\/)archive_browser\.html$/i.test(x.name) && !/(^|\/)Keep\/Labels\.txt$/i.test(x.name)); // Google Takeout's own index and Keep's label list
    // A whole Download your data .zip: only its Notes/ folder (not its chat, forms, README or the one-file Notes.md).
    const takeout = /Your Workspace data/.test(await zip.file('README.txt')?.async('string') || '') && inside.some((x) => x.name.startsWith('Notes/'));
    if (takeout) inside = inside.filter((x) => x.name.startsWith('Notes/'));
    if (!inside.length) throw bad(`There are no notes in “${f.name}”`);
    if (inside.length > 5000) throw bad(`“${f.name}” has more than 5,000 files`);
    // Pictures a Markdown note shows from the same .zip ("![](Trip files/picture-1.jpg)", as Download (.zip) writes) come with it.
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    for (const x of inside) {
      const text = await x.async('string');
      const pictures = [];
      if (/\.json$/i.test(x.name)) {
        // Google Keep: a note's photos are listed under "attachments", beside its .json in the Takeout (".jpeg" said, ".jpg" there, sometimes).
        let k = null; try { k = JSON.parse(text); } catch { /* not Keep's; the import says so */ }
        const dir = x.name.includes('/') ? x.name.slice(0, x.name.lastIndexOf('/') + 1) : '';
        for (const a of Array.isArray(k?.attachments) ? k.attachments : []) {
          const fp = String(a?.filePath || '');
          const mime = String(a?.mimetype || '').toLowerCase().replace('image/jpg', 'image/jpeg');
          if (!fp || fp.includes('..') || !Object.values(MIME).includes(mime) || pictures.length >= MAX_PICTURES) continue;
          const alt = fp.replace(/\.jpe?g$/i, (e) => (e.toLowerCase() === '.jpg' ? '.jpeg' : '.jpg'));
          const entry = zip.file(dir + fp) || zip.file(dir + alt);
          if (!entry) continue;
          const data = await entry.async('nodebuffer');
          if (data.length <= MAX_PICTURE_BYTES) pictures.push({ line: null, mime, data });
        }
      }
      if (/\.html?$/i.test(x.name)) {
        // An HTML note's <img src="…"> pointing at a picture in the same .zip.
        const dir = x.name.includes('/') ? x.name.slice(0, x.name.lastIndexOf('/') + 1) : '';
        for (const m of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
          const src = m[1];
          if (/^(data|https?):/i.test(src) || src.includes('..') || pictures.some((p) => p.src === src)) continue;
          let rel; try { rel = decodeURI(src); } catch { continue; }
          const entry = zip.file(dir + rel) || zip.file(rel);
          const mime = MIME[String(rel.split('.').pop()).toLowerCase()];
          if (!entry || !mime || pictures.length >= MAX_PICTURES) continue;
          const data = await entry.async('nodebuffer');
          if (data.length <= MAX_PICTURE_BYTES) pictures.push({ line: null, src, mime, data });
        }
      }
      if (/\.(md|markdown)$/i.test(x.name)) {
        const dir = x.name.includes('/') ? x.name.slice(0, x.name.lastIndexOf('/') + 1) : '';
        for (const m of text.matchAll(/^!\[[^\]]*\]\(<?([^)>\s]+)>?\)\s*$/gm)) {
          let rel; try { rel = decodeURI(m[1]); } catch { continue; }
          const entry = zip.file(dir + rel) || zip.file(rel);
          const mime = MIME[String(rel.split('.').pop()).toLowerCase()];
          if (!entry || !mime || pictures.length >= MAX_PICTURES) continue;
          const data = await entry.async('nodebuffer');
          if (data.length <= MAX_PICTURE_BYTES) pictures.push({ line: m[0], mime, data });
        }
      }
      files.push({ name: x.name.split('/').pop(), text: pictures.reduce((t2, p2) => (p2.line ? t2.replace(p2.line, '') : t2), text).replace(/\n{3,}$/, '\n'), pictures });
    }
  }
  if (!files.length) throw bad('Choose some .md, .txt, .html, Evernote .enex or Google Keep .json files');
  if (files.length > 2000) throw bad('Up to 2,000 files at a time');
  const have = q('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').get(user.id).n;
  const keepJson = new Set(files.filter((f) => /\.json$/i.test(String(f?.name || ''))).map((f) => String(f.name).replace(/\.json$/i, '').toLowerCase()));
  const all = files.flatMap((f) => {
    // Evernote (.enex): many notes in one file.
    if (/\.enex$/i.test(String(f?.name || ''))) {
      if (String(f?.text ?? '').length > 20e6) throw bad(`“${f.name}” is too big: export fewer notes at a time`);
      const found = notesFromEnex(f.text);
      if (found.error) throw bad(`“${f.name}”: ${found.error}`);
      return found.notes.map((n) => ({ ...n, items: n.items ? cleanItems(n.items) : null, labels: cleanLabels(n.labels) }));
    }
    if (String(f?.text ?? '').length > 200000 && !/\.html?$/i.test(String(f?.name || ''))) throw bad(`“${f?.name || 'A file'}” is too big for a note`);
    if (/\.html?$/i.test(String(f?.name || ''))) {
      // Google Keep's Takeout has an .html beside each .json: when both came, the .json (with colour, labels…) is used.
      if (keepJson.has(String(f.name).replace(/\.html?$/i, '').toLowerCase())) return [];
      if (String(f?.text ?? '').length > 20e6) throw bad(`“${f.name}” is too big for a note`);
      const n = noteFromHtml(f.text, f.name, { files: new Map((f.pictures || []).map((p) => [p.src, p])) });
      return [{ ...n, items: n.items ? cleanItems(n.items) : null, labels: cleanLabels(n.labels) }];
    }
    if (/\.json$/i.test(String(f?.name || ''))) {
      let k = null; try { k = JSON.parse(f.text); } catch { throw bad(`“${f.name}” isn't a Google Keep note`); }
      const n = keepNote(k, { hasPictures: !!f.pictures?.length });
      return [n && { ...n, items: n.items ? cleanItems(n.items) : null, labels: cleanLabels(n.labels), pictures: f.pictures || [] }];
    }
    return [String(f?.text ?? '').trim() || f?.pictures?.length ? { ...noteFromMarkdown(f.text, f?.name), pictures: f.pictures || [] } : null]; // a blank file isn't a note
  });
  const notes = all.filter((n) => n && (n.title.trim() || n.body.trim() || (n.items || []).length || n.pictures?.length));
  if (have + notes.length > MAX_NOTES) throw bad(`You can have up to ${MAX_NOTES} notes`);
  const t = now();
  let top = topFor(user.id);
  const picBytes = notes.reduce((sum, n) => sum + (n.pictures || []).reduce((x, p) => x + p.data.length, 0), 0);
  if (picBytes) checkQuota(user.org_id, picBytes, user.id);
  const written = [], pics = [];
  try { tx(() => {
    for (const n of [...notes].reverse()) { // the first file ends up first
      const noteId = uid();
      for (const p of n.pictures || []) {
        const storage = uid();
        fs.writeFileSync(path.join(FILES_DIR, storage), p.data);
        written.push(storage);
        pics.push([uid(), noteId, storage, p.mime, p.data.length]);
      }
      q(`INSERT INTO notes (id, owner_id, title, body, items, color, pinned, archived, labels, position, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(noteId, user.id, n.title, n.body, n.items ? JSON.stringify(n.items) : null, n.color || null, n.pinned ? 1 : 0, n.archived ? 1 : 0, JSON.stringify(n.labels),
          top, n.created_at || t, n.updated_at || n.created_at || t, user.id);
      top += 1;
    }
    for (const p of pics) q('INSERT INTO note_pictures (id, note_id, storage, mime, size, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...p, user.id, t);
  }); } catch (e) { for (const f of written) fs.rmSync(path.join(FILES_DIR, f), { force: true }); throw e; }
  sendTo([user.id], { type: 'notes-changed' });
  return { added: notes.length, skipped: all.length - notes.length }; // empty ones, and ones in Keep's trash
}

export default function noteRoutes() {
  const r = Router();

  // Yours and those shared with you: ?archived=1 for the archive, ?q= words to search, ?label= one label.
  r.get('/', (req, res) => {
    const archived = req.query.archived === '1' ? 1 : 0;
    if (req.query.trash === '1') { // your deleted notes, most recent first
      return res.json(q('SELECT * FROM notes WHERE owner_id = ? AND trashed_at IS NOT NULL ORDER BY trashed_at DESC').all(req.user.id).map((n) => shape(n, req.user.id)));
    }
    let rows = q(`SELECT n.* FROM notes n LEFT JOIN note_order o ON o.note_id = n.id AND o.user_id = ?
                  WHERE (n.owner_id = ? OR n.id IN (SELECT note_id FROM note_shares WHERE user_id = ?)) AND n.archived = ? AND n.trashed_at IS NULL
                  ORDER BY n.pinned DESC, COALESCE(o.position, n.position) DESC`).all(req.user.id, req.user.id, req.user.id, archived);
    const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      rows = rows.filter((n) => {
        const text = `${n.title} ${n.body} ${(n.items ? JSON.parse(n.items) : []).map((i) => i.text).join(' ')} ${JSON.parse(n.labels).join(' ')}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
    }
    if (req.query.reminders === '1') rows = q(`SELECT n.* FROM notes n WHERE (n.owner_id = ? OR n.id IN (SELECT note_id FROM note_shares WHERE user_id = ?)) AND n.remind_at IS NOT NULL AND n.trashed_at IS NULL
                                                ORDER BY n.remind_at`).all(req.user.id, req.user.id);
    if (req.query.label) rows = rows.filter((n) => JSON.parse(n.labels).includes(String(req.query.label)));
    res.json(rows.map((n) => shape(n, req.user.id)));
  });

  // Your order of the cards: { ids } as they should now show, first to last (yours and shared ones;
  // others see their own order). They go above the rest, in that order.
  r.post('/order', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))].slice(0, MAX_NOTES) : null;
    if (!ids?.length) throw bad('Which notes, in which order?');
    const mine = new Set(q('SELECT id FROM notes WHERE (owner_id = ? OR id IN (SELECT note_id FROM note_shares WHERE user_id = ?)) AND trashed_at IS NULL').all(req.user.id, req.user.id).map((x) => x.id));
    const ok = ids.filter((id) => mine.has(id));
    const top = topFor(req.user.id) + ok.length;
    const put = q('INSERT INTO note_order (user_id, note_id, position) VALUES (?, ?, ?) ON CONFLICT (user_id, note_id) DO UPDATE SET position = excluded.position');
    tx(() => ok.forEach((id, i) => put.run(req.user.id, id, top - i)));
    sendTo([req.user.id], { type: 'notes-changed' }); // your other tabs and devices
    res.json({ ok: true, ordered: ok.length });
  });

  // Every label you use (on your notes and those shared with you), for the sidebar.
  // Label colours, your own (a shared note's labels show in your colours for you): { label: colour }.
  r.get('/label-colors', (req, res) => {
    res.json(Object.fromEntries(q('SELECT label, color FROM note_label_colors WHERE user_id = ?').all(req.user.id).map((r) => [r.label, r.color])));
  });
  r.put('/label-colors', (req, res) => {
    const label = str(req.body?.label, { required: true, max: 50, name: 'Label' });
    const color = req.body?.color || null;
    if (color && !LABEL_COLORS.includes(color)) throw bad('Choose one of the colours');
    if (color) q('INSERT INTO note_label_colors (user_id, label, color) VALUES (?, ?, ?) ON CONFLICT(user_id, label) DO UPDATE SET color = excluded.color').run(req.user.id, label, color);
    else q('DELETE FROM note_label_colors WHERE user_id = ? AND label = ?').run(req.user.id, label);
    sendTo([req.user.id], { type: 'notes-changed' });
    res.json({ label, color });
  });

  // Rename a label ({ from, to }; to an existing one merges them) or delete it ({ label }) on every note you
  // see: yours and those shared with you (their people see the change too). Your colour goes with the name.
  const relabel = (user, from, fn) => {
    const rows = q(`SELECT id, labels FROM notes WHERE (owner_id = ? OR (trashed_at IS NULL AND id IN (SELECT note_id FROM note_shares WHERE user_id = ?)))`).all(user.id, user.id)
      .filter((n) => JSON.parse(n.labels || '[]').includes(from));
    const people = new Set([user.id]);
    tx(() => {
      for (const n of rows) {
        q('UPDATE notes SET labels = ? WHERE id = ?').run(JSON.stringify(cleanLabels(fn(JSON.parse(n.labels || '[]')))), n.id);
        const o = q('SELECT owner_id FROM notes WHERE id = ?').get(n.id); people.add(o.owner_id);
        for (const s of q('SELECT user_id FROM note_shares WHERE note_id = ?').all(n.id)) people.add(s.user_id);
      }
    });
    sendTo([...people], { type: 'notes-changed' });
    return rows.length;
  };
  r.post('/labels/rename', (req, res) => {
    const from = str(req.body?.from, { required: true, max: 50, name: 'Label' });
    const to = str(req.body?.to, { required: true, max: 40, name: 'New name' }).trim();
    if (!to) throw bad('Give the label a name');
    const notes = from === to ? 0 : relabel(req.user, from, (ls) => ls.map((l) => (l === from ? to : l)));
    if (from !== to) {
      const c = q('SELECT color FROM note_label_colors WHERE user_id = ? AND label = ?').get(req.user.id, from);
      if (c) q('INSERT INTO note_label_colors (user_id, label, color) VALUES (?, ?, ?) ON CONFLICT(user_id, label) DO NOTHING').run(req.user.id, to, c.color);
      q('DELETE FROM note_label_colors WHERE user_id = ? AND label = ?').run(req.user.id, from);
    }
    res.json({ label: to, notes });
  });
  r.post('/labels/delete', (req, res) => {
    const label = str(req.body?.label, { required: true, max: 50, name: 'Label' });
    const notes = relabel(req.user, label, (ls) => ls.filter((l) => l !== label));
    q('DELETE FROM note_label_colors WHERE user_id = ? AND label = ?').run(req.user.id, label);
    res.json({ notes });
  });

  const prefsOf = (userId) => { const p = q('SELECT view, sort FROM note_prefs WHERE user_id = ?').get(userId); return { view: p?.view || 'grid', sort: p?.sort || 'mine' }; };
  r.get('/view', (req, res) => res.json(prefsOf(req.user.id)));
  // { view } and/or { sort }; what isn't sent stays.
  r.put('/view', (req, res) => {
    const cur = prefsOf(req.user.id);
    const view = req.body?.view === undefined ? cur.view : String(req.body.view);
    const sort = req.body?.sort === undefined ? cur.sort : String(req.body.sort);
    if (!NOTE_VIEWS.includes(view)) throw bad('Grid or list');
    if (!NOTE_SORTS.includes(sort)) throw bad('Your order, last edited, newest or title');
    q('INSERT INTO note_prefs (user_id, view, sort) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET view = excluded.view, sort = excluded.sort').run(req.user.id, view, sort);
    sendTo([req.user.id], { type: 'notes-changed' });
    res.json({ view, sort });
  });

  r.get('/labels', (req, res) => {
    const all = new Set();
    for (const n of q('SELECT labels FROM notes WHERE owner_id = ? OR id IN (SELECT note_id FROM note_shares WHERE user_id = ?)').all(req.user.id, req.user.id)) {
      for (const l of JSON.parse(n.labels || '[]')) all.add(l);
    }
    res.json([...all].sort((a, b) => a.localeCompare(b)));
  });

  // Import notes from Markdown or text files, from Evernote (.enex, many notes each), or from Google Keep (the .json files in Google Takeout's Keep folder,
  // keeping colour, pin, archive and dates): { files: [{ name, text }] } (up to 2,000, 200 KB each). Empty ones, and
  // ones in Keep's trash, are skipped.
  r.post('/import', async (req, res) => {
    res.status(201).json(await importNotes(req.user, req.body));
  });

  r.post('/', (req, res) => {
    if (q('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?').get(req.user.id).n >= MAX_NOTES) throw bad(`You can have up to ${MAX_NOTES} notes`);
    const b = req.body || {};
    const items = b.items === undefined ? null : cleanItems(b.items);
    const title = str(b.title ?? '', { max: 300 }) || '';
    const body = str(b.body ?? '', { max: 20000 }) || '';
    if (!title.trim() && !body.trim() && !(items || []).some((i) => i.text.trim())) throw bad('The note is empty');
    if (b.color && !COLORS.includes(b.color)) throw bad('Unknown colour');
    const id = uid(), t = now();
    const top = topFor(req.user.id);
    q(`INSERT INTO notes (id, owner_id, title, body, items, color, pinned, labels, position, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, title, body, items ? JSON.stringify(items) : null, b.color || null, b.pinned ? 1 : 0, JSON.stringify(cleanLabels(b.labels || [])), top, t, t, req.user.id);
    const n = q('SELECT * FROM notes WHERE id = ?').get(id);
    tell(n);
    res.status(201).json(shape(n, req.user.id));
  });

  r.patch('/:id', (req, res) => {
    const n = load(req.params.id, req.user);
    const b = req.body || {};
    const set = {};
    if (b.title !== undefined) set.title = str(b.title, { max: 300 }) || '';
    if (b.body !== undefined) set.body = str(b.body, { max: 20000 }) || '';
    if (b.items !== undefined) { const items = cleanItems(b.items); set.items = items ? JSON.stringify(items) : null; }
    if (b.color !== undefined) { if (b.color && !COLORS.includes(b.color)) throw bad('Unknown colour'); set.color = b.color || null; }
    if (b.pinned !== undefined) set.pinned = b.pinned ? 1 : 0;
    if (b.archived !== undefined) { set.archived = b.archived ? 1 : 0; if (b.archived) set.pinned = 0; }
    if (b.labels !== undefined) set.labels = JSON.stringify(cleanLabels(b.labels));
    if (b.position !== undefined) { if (!Number.isFinite(Number(b.position))) throw bad('Bad position'); set.position = Number(b.position); }
    if (b.remind_at !== undefined) {
      if (b.remind_at === null || b.remind_at === '') set.remind_at = null;
      else {
        const t = Number(b.remind_at);
        if (!Number.isFinite(t) || t < now() - 60e3) throw bad('Pick a time in the future for the reminder');
        set.remind_at = Math.round(t);
      }
    }
    // { remind_repeat: 'daily' | 'weekdays' | 'weekly' | 'monthly' | null, remind_tz }: only with a reminder.
    if (b.remind_repeat !== undefined) {
      if (b.remind_repeat && !REPEATS.includes(b.remind_repeat)) throw bad('Repeat daily, weekdays, weekly or monthly');
      set.remind_repeat = b.remind_repeat || null;
      if (b.remind_tz !== undefined) set.remind_tz = zoneOrUtc(String(b.remind_tz || 'UTC'));
    }
    if (b.remind_reset !== undefined) set.remind_reset = b.remind_reset ? 1 : 0;
    if (set.remind_at === null) set.remind_repeat = null; // taking the reminder off ends its repeating
    if (set.remind_repeat && !(set.remind_at ?? n.remind_at)) throw bad('Set a time for the reminder first');
    const keys = Object.keys(set);
    if (keys.length) versionBefore(n, req.user.id, set);
    if (keys.length) q(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...keys.map((k) => set[k]), now(), req.user.id, n.id);
    const after = q('SELECT * FROM notes WHERE id = ?').get(n.id);
    tell(after);
    res.json(shape(after, req.user.id));
  });

  // Show tick boxes (text → checklist) or Hide tick boxes (checklist → text). Kept in the version history.
  r.post('/:id/convert', (req, res) => {
    const n = load(req.params.id, req.user);
    if (n.trashed_at) throw bad('Restore the note first');
    const to = req.body?.to;
    let set;
    if (to === 'checklist') { if (n.items) throw bad('It’s a checklist already'); set = { items: JSON.stringify(textToItems(n.body)), body: '' }; }
    else if (to === 'text') { if (!n.items) throw bad('It’s text already'); set = { items: null, body: itemsToText(JSON.parse(n.items)).slice(0, 20000) }; }
    else throw bad('Convert to checklist or text');
    versionBefore(n, req.user.id, set);
    q('UPDATE notes SET items = ?, body = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(set.items, set.body, now(), req.user.id, n.id);
    const after = q('SELECT * FROM notes WHERE id = ?').get(n.id);
    tell(after);
    res.json(shape(after, req.user.id));
  });

  // Version history: newest first, with who saved each; restoring one keeps the current text first.
  // A link to a note, pasted in Chat: what it says (the start of it, or the first items of a checklist), for a
  // card. Only for its owner and the people it's shared with; a note in the trash counts as gone.
  // One note as a Markdown file (works in any text editor, Obsidian, GitHub…).
  // Several notes as one .zip of Markdown files (?ids=a,b,c), named by title ("Shopping.md", a second one "Shopping (2).md").
  r.get('/export.zip', async (req, res) => {
    const ids = [...new Set(String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean))];
    if (!ids.length) throw bad('No notes selected');
    if (ids.length > 2000) throw bad('Up to 2,000 notes at a time');
    const notes = ids.map((id) => load(id, req.user)).filter((n) => !n.trashed_at);
    if (!notes.length) throw notFound('Note not found');
    if (req.query.check === '1') return res.json({ notes: notes.length });
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    for (const e of await notesZipEntries(notes)) zip.file(e.path, e.data, { binary: typeof e.data !== 'string' });
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="notes.zip"; filename*=UTF-8''${encodeURIComponent(`Notes (${notes.length}).zip`)}`);
    res.end(buf);
  });
  r.get('/:id/export.md', (req, res) => {
    const n = load(req.params.id, req.user);
    const note = { title: n.title, body: n.body, items: n.items ? JSON.parse(n.items) : null, labels: JSON.parse(n.labels || '[]') };
    const name = (n.title || 'Note').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Note';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="note.md"; filename*=UTF-8''${encodeURIComponent(name)}.md`);
    res.send(noteMarkdown(note));
  });
  // Tick one item (and its sub-items, as in the note) or untick it, without sending the whole list: from a note's
  // card in Chat, say. { done }. Kept in the version history like any other change.
  r.put('/:id/items/:itemId', (req, res) => {
    const n = load(req.params.id, req.user);
    if (n.trashed_at) throw notFound('Note not found');
    const items = n.items ? JSON.parse(n.items) : null;
    const i = items ? items.findIndex((x) => x.id === req.params.itemId) : -1;
    if (i < 0) throw notFound('That item isn’t on the list any more');
    let end = i;
    if (!items[i].indent) while (items[end + 1]?.indent) end++;
    const done = !!req.body?.done;
    const next = items.map((x, k) => (k >= i && k <= end ? { ...x, done } : x));
    const set = { items: JSON.stringify(next) };
    versionBefore(n, req.user.id, set);
    q('UPDATE notes SET items = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(set.items, now(), req.user.id, n.id);
    tell(n);
    res.json({ done: next.filter((x) => x.done).length, total: next.length });
  });

  // Chat with people it's shared with: a private channel for a shared note (its owner and everyone it's shared with),
  // made once; the same one after, with anyone it was shared with since added. { id, created, added }.
  r.post('/:id/chat', async (req, res) => {
    const n = load(req.params.id, req.user);
    if (n.trashed_at) throw notFound('Note not found');
    const people = [n.owner_id, ...q('SELECT user_id FROM note_shares WHERE note_id = ?').all(n.id).map((x) => x.user_id)];
    if (new Set(people).size < 2) throw bad('Share the note with someone first');
    const { eventChannel } = await import('./chat.js');
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const title = n.title || (n.body || '').split('\n')[0].slice(0, 60) || 'note';
    const out = eventChannel(req.user, { aboutId: n.id, kind: 'note', existingId: n.chat_channel_id, title, people, link: `${base}/notes?note=${n.id}`,
      topic: `About the note ${String(title).slice(0, 120)}`, intro: `For the note ${title}: ${base}/notes?note=${n.id}` });
    if (out.id !== n.chat_channel_id) q('UPDATE notes SET chat_channel_id = ? WHERE id = ?').run(out.id, n.id);
    res.json(out);
  });

  r.get('/:id/preview', (req, res) => {
    const n = load(req.params.id, req.user);
    if (n.trashed_at) throw notFound('Note not found');
    const items = n.items ? JSON.parse(n.items) : null;
    const body = n.body || '';
    res.json({
      id: n.id, title: n.title || '', color: n.color || null, archived: !!n.archived, mine: n.owner_id === req.user.id,
      owner_name: q('SELECT name FROM users WHERE id = ?').get(n.owner_id)?.name || null,
      body: items ? null : (body.length > 300 ? `${body.slice(0, 300)}…` : body),
      items: items ? { done: items.filter((i) => i.done).length, total: items.length, first: items.slice(0, 5).map((i) => ({ id: i.id, text: String(i.text || '').slice(0, 120), done: !!i.done, ...(i.indent && { indent: 1 }) })) } : null,
      pictures: picturesOf(n.id).length, updated_at: n.updated_at,
    });
  });
  r.get('/:id/versions', (req, res) => {
    const n = load(req.params.id, req.user);
    const names = new Map();
    const nameOf = (id) => { if (!names.has(id)) names.set(id, q('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone'); return names.get(id); };
    res.json(q('SELECT * FROM note_versions WHERE note_id = ? ORDER BY saved_at DESC').all(n.id).filter((v) => !sameContent(v, n))
      .map((v) => ({ id: v.id, title: v.title, body: v.body, items: v.items ? JSON.parse(v.items) : null, saved_at: v.saved_at, saved_by: nameOf(v.saved_by) })));
  });
  r.post('/:id/versions/:vid/restore', (req, res) => {
    const n = load(req.params.id, req.user);
    const v = q('SELECT * FROM note_versions WHERE id = ? AND note_id = ?').get(req.params.vid, n.id);
    if (!v) throw notFound('Version not found');
    keepVersion(n);
    q('UPDATE notes SET title = ?, body = ?, items = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(v.title, v.body, v.items, now(), req.user.id, n.id);
    const after = q('SELECT * FROM notes WHERE id = ?').get(n.id);
    tell(after);
    res.json(shape(after, req.user.id));
  });

  // Several notes at once: a colour, pinned or not, archived or not, a label added, or to the trash
  // (for one shared with you: taking yourself off it, as deleting it does). All are checked first.
  r.post('/batch', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))];
    if (!ids.length) throw bad('Choose some notes');
    if (ids.length > 500) throw bad('500 notes at a time at most');
    const notes = ids.map((id) => load(id, req.user));
    if (req.body?.trash === true) {
      const told = new Set(notes.flatMap((n) => team(n)));
      tx(() => { for (const n of notes) {
        if (n.owner_id !== req.user.id) q('DELETE FROM note_shares WHERE note_id = ? AND user_id = ?').run(n.id, req.user.id);
        else q('UPDATE notes SET trashed_at = ?, pinned = 0 WHERE id = ?').run(now(), n.id);
      } });
      sendTo([...told], { type: 'notes-changed' });
      return res.json({ trashed: notes.filter((n) => n.owner_id === req.user.id).length, left: notes.filter((n) => n.owner_id !== req.user.id).length });
    }
    const b = req.body?.change || {};
    const set = {};
    if (b.color !== undefined) { if (b.color && !COLORS.includes(b.color)) throw bad('Unknown colour'); set.color = b.color || null; }
    if (b.pinned !== undefined) set.pinned = b.pinned ? 1 : 0;
    if (b.archived !== undefined) { set.archived = b.archived ? 1 : 0; if (b.archived) set.pinned = 0; }
    const label = b.label !== undefined ? cleanLabels([b.label])[0] : undefined;
    if (b.label !== undefined && !label) throw bad('Name the label');
    if (!Object.keys(set).length && !label) throw bad('Nothing to change');
    const keys = Object.keys(set);
    tx(() => { for (const n of notes) {
      if (keys.length) q(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...keys.map((k) => set[k]), now(), req.user.id, n.id);
      if (label) {
        const had = JSON.parse(q('SELECT labels FROM notes WHERE id = ?').get(n.id).labels || '[]');
        if (!had.includes(label)) q('UPDATE notes SET labels = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(JSON.stringify(cleanLabels([...had, label])), now(), req.user.id, n.id);
      }
    } });
    for (const n of notes) tell(q('SELECT * FROM notes WHERE id = ?').get(n.id));
    res.json({ notes: notes.map((n) => shape(q('SELECT * FROM notes WHERE id = ?').get(n.id), req.user.id)) });
  });

  // Make a copy (yours, not shared).
  r.post('/:id/copy', (req, res) => {
    const n = load(req.params.id, req.user);
    const id = uid(), t = now();
    const top = topFor(req.user.id);
    q(`INSERT INTO notes (id, owner_id, title, body, items, color, pinned, labels, position, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, n.title, n.body, n.items, n.color, n.labels, top, t, t, req.user.id);
    for (const p of q('SELECT * FROM note_pictures WHERE note_id = ? ORDER BY created_at').all(n.id)) { // the pictures too, as copies of their own
      const storage = uid();
      try { fs.copyFileSync(path.join(FILES_DIR, p.storage), path.join(FILES_DIR, storage)); } catch { continue; }
      q('INSERT INTO note_pictures (id, note_id, storage, mime, size, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(uid(), id, storage, p.mime, p.size, req.user.id, p.created_at);
    }
    const c = q('SELECT * FROM notes WHERE id = ?').get(id);
    tell(c);
    res.status(201).json(shape(c, req.user.id));
  });

  // A copy as a document in your Drive: the title as a heading, text as paragraphs, a checklist as tick boxes, then its pictures.
  r.post('/:id/doc', (req, res) => {
    const n = load(req.params.id, req.user);
    const para = (text) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
    const items = n.items ? JSON.parse(n.items) : null;
    const content = [
      ...(n.title ? [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: n.title }] }] : []),
      ...(items ? (items.length ? [{ type: 'taskList', content: taskItems(items, para) }] : [])
        : String(n.body || '').split('\n').map((line) => para(line))),
    ];
    // Its pictures come too: each copied into your Drive, shown after the text.
    const pics = q('SELECT * FROM note_pictures WHERE note_id = ? ORDER BY created_at').all(n.id);
    checkQuota(req.user.org_id, pics.reduce((t, p) => t + p.size, 0), req.user.id);
    const name = (n.title || (n.body || '').split('\n')[0] || 'Note').slice(0, 120);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const images = [];
    // They go in one "Pictures from notes" folder in My Drive (made when first needed), not loose beside the document.
    const picFolder = !pics.length ? null : q("SELECT id FROM files WHERE owner_id = ? AND parent_id IS NULL AND kind = 'folder' AND name = 'Pictures from notes' AND trashed = 0").get(req.user.id)?.id
      || insertFile({ owner: req.user.id, parentId: null, name: 'Pictures from notes', kind: 'folder' });
    for (const [i, p] of pics.entries()) {
      const storage = uid();
      try { fs.copyFileSync(path.join(FILES_DIR, p.storage), path.join(FILES_DIR, storage)); } catch { continue; }
      const fileId = insertFile({ owner: req.user.id, parentId: picFolder, name: `${name} – picture ${i + 1}.${ext[p.mime] || 'png'}`, kind: 'file', mime: p.mime, size: p.size, storage });
      images.push({ type: 'image', attrs: { fileId, alt: `${name} – picture ${i + 1}` } });
    }
    const all = [...content, ...images];
    const json = JSON.stringify({ type: 'doc', content: all.length ? all : [para('')] });
    const id = insertFile({ owner: req.user.id, parentId: null, name, kind: 'doc', content: json, size: Buffer.byteLength(json) });
    res.status(201).json({ id, pictures: images.length });
  });

  // The checklist's unticked items (or the note itself) as tasks on your first list.
  r.post('/:id/tasks', (req, res) => {
    const n = load(req.params.id, req.user);
    const items = n.items ? tasksFromItems(JSON.parse(n.items)) : [];
    const titles = items.length ? items : [n.title || (n.body || '').split('\n')[0]].filter((x) => x && x.trim());
    if (!titles.length) throw bad('Nothing to add as a task');
    const list = myFirstList(req.user.id);
    addTasks(list.id, req.user.id, titles);
    sendTo([req.user.id], { type: 'tasks-changed', list_id: list.id });
    res.status(201).json({ added: titles.length, list: { id: list.id, name: list.name } });
  });

  // Who it's shared with: { user_ids } (colleagues in your company). The owner decides.
  r.put('/:id/shares', (req, res) => {
    const n = load(req.params.id, req.user);
    if (n.owner_id !== req.user.id) throw forbidden('Only the owner can change who it is shared with');
    const ids = Array.isArray(req.body?.user_ids) ? [...new Set(req.body.user_ids.map(String))].filter((x) => x !== n.owner_id) : null;
    if (!ids) throw bad('user_ids must be a list');
    const before = team(n);
    tx(() => {
      for (const id of ids) if (!q('SELECT 1 FROM users WHERE id = ? AND org_id = ? AND disabled = 0').get(id, req.user.org_id)) throw bad('You can share notes with people in your company');
      q('DELETE FROM note_shares WHERE note_id = ?').run(n.id);
      for (const id of ids) q('INSERT INTO note_shares (note_id, user_id) VALUES (?, ?)').run(n.id, id);
    });
    const added = ids.filter((id) => !before.includes(id));
    if (added.length) bell(added, { kind: 'share', title: `${req.user.name} shared a note with you`, body: n.title || (n.body || '').slice(0, 80) || null, link: '/notes', actor: req.user.name });
    sendTo([...new Set([...before, ...ids])], { type: 'notes-changed' });
    res.json(shape(q('SELECT * FROM notes WHERE id = ?').get(n.id), req.user.id));
  });

  // Pictures: add one (the raw image as the body), show one, or take one off. Anyone on the note can.
  r.post('/:id/pictures', async (req, res) => {
    const n = load(req.params.id, req.user);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!PICTURE_TYPES.includes(mime)) throw bad('Add a PNG, JPEG, GIF or WebP picture');
    if (picturesOf(n.id).length >= MAX_PICTURES) throw bad(`A note can have up to ${MAX_PICTURES} pictures`);
    const owner = q('SELECT id, org_id FROM users WHERE id = ?').get(n.owner_id);
    const { storage, size } = await receiveUpload(req, owner.org_id, MAX_PICTURE_BYTES, owner.id).catch((e) => { throw e.status === 413 ? bad('Pictures can be up to 10 MB') : e; });
    const id = uid();
    q('INSERT INTO note_pictures (id, note_id, storage, mime, size, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, n.id, storage, mime, size, req.user.id, now());
    q('UPDATE notes SET updated_at = ?, updated_by = ? WHERE id = ?').run(now(), req.user.id, n.id);
    tell(n);
    res.status(201).json(shape(q('SELECT * FROM notes WHERE id = ?').get(n.id), req.user.id));
  });
  r.get('/:id/pictures/:pid', (req, res) => {
    const n = load(req.params.id, req.user);
    const p = q('SELECT * FROM note_pictures WHERE id = ? AND note_id = ?').get(req.params.pid, n.id);
    if (!p) throw notFound();
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(path.join(FILES_DIR, p.storage)).on('error', () => res.destroy()).pipe(res);
  });
  r.delete('/:id/pictures/:pid', (req, res) => {
    const n = load(req.params.id, req.user);
    const p = q('SELECT * FROM note_pictures WHERE id = ? AND note_id = ?').get(req.params.pid, n.id);
    if (!p) throw notFound();
    q('DELETE FROM note_pictures WHERE id = ?').run(p.id);
    dropPictureFiles([p]);
    q('UPDATE notes SET updated_at = ?, updated_by = ? WHERE id = ?').run(now(), req.user.id, n.id);
    tell(n);
    res.json(shape(q('SELECT * FROM notes WHERE id = ?').get(n.id), req.user.id));
  });

  // Empty the trash: your deleted notes go for good.
  r.delete('/trash', (req, res) => {
    const list = q('SELECT id FROM notes WHERE owner_id = ? AND trashed_at IS NOT NULL').all(req.user.id);
    for (const n of list) { dropPictureFiles(q('SELECT storage FROM note_pictures WHERE note_id = ?').all(n.id)); q('DELETE FROM notes WHERE id = ?').run(n.id); }
    sendTo([req.user.id], { type: 'notes-changed' });
    res.json({ ok: true, deleted: list.length });
  });

  // Delete (the owner): to the trash, or for good with ?forever=1 (or when it's already there).
  // Someone it's shared with takes themselves off it instead.
  r.delete('/:id', (req, res) => {
    const n = load(req.params.id, req.user);
    const before = team(n);
    let trashed = false;
    if (n.owner_id !== req.user.id) q('DELETE FROM note_shares WHERE note_id = ? AND user_id = ?').run(n.id, req.user.id);
    else if (req.query.forever === '1' || n.trashed_at) { dropPictureFiles(q('SELECT storage FROM note_pictures WHERE note_id = ?').all(n.id)); q('DELETE FROM notes WHERE id = ?').run(n.id); }
    else { q('UPDATE notes SET trashed_at = ?, pinned = 0 WHERE id = ?').run(now(), n.id); trashed = true; }
    sendTo(before, { type: 'notes-changed' });
    res.json({ ok: true, deleted: n.owner_id === req.user.id, trashed });
  });
  // Back from the trash, as it was.
  r.post('/:id/restore', (req, res) => {
    const n = load(req.params.id, req.user);
    if (n.owner_id !== req.user.id) throw notFound('Note not found');
    q('UPDATE notes SET trashed_at = NULL, updated_at = ? WHERE id = ?').run(now(), n.id);
    tell(n);
    res.json(shape(q('SELECT * FROM notes WHERE id = ?').get(n.id), req.user.id));
  });

  return r;
}
