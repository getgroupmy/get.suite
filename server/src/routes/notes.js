// Notes: quick notes and checklists on coloured cards. Pin the important ones, give them labels, archive
// what's done with, and share a note with colleagues to keep it together (everyone it's shared with can
// change it; only its owner can delete it). Mounted at /api/notes.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { sendTo } from '../hub.js';
import { notify as bell } from '../notifications.js';
import { insertFile, receiveUpload } from './files.js';
import fs from 'node:fs';
import path from 'node:path';
import { FILES_DIR } from '../db.js';
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

// Trash: a deleted note waits here for its owner (restore it, or delete it for good) for TRASH_DAYS.
if (!q('PRAGMA table_info(notes)').all().some((c) => c.name === 'trashed_at')) q('ALTER TABLE notes ADD COLUMN trashed_at INTEGER').run();
export const TRASH_DAYS = 7;

const team = (n) => [n.owner_id, ...q('SELECT user_id FROM note_shares WHERE note_id = ?').all(n.id).map((s) => s.user_id)];
function shape(n, me) {
  return {
    id: n.id, title: n.title, body: n.body, items: n.items ? JSON.parse(n.items) : null, color: n.color, pinned: !!n.pinned, archived: !!n.archived, trashed_at: n.trashed_at ?? null,
    labels: JSON.parse(n.labels || '[]'), remind_at: n.remind_at ?? null, pictures: picturesOf(n.id).map((p) => p.id), position: n.position, created_at: n.created_at, updated_at: n.updated_at, mine: n.owner_id === me,
    owner: q('SELECT id, name, username FROM users WHERE id = ?').get(n.owner_id),
    shared: q(`SELECT u.id, u.name, u.username FROM note_shares s JOIN users u ON u.id = s.user_id WHERE s.note_id = ? ORDER BY u.name`).all(n.id),
  };
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

/** Send the reminders that are due (to everyone on each note), then clear them. */
export function remindNotesDue(at = now()) {
  const due = q('SELECT * FROM notes WHERE remind_at IS NOT NULL AND remind_at <= ? AND trashed_at IS NULL ORDER BY remind_at LIMIT 100').all(at);
  for (const n of due) {
    q('UPDATE notes SET remind_at = NULL WHERE id = ?').run(n.id);
    const items = n.items ? JSON.parse(n.items).filter((i) => !i.done).map((i) => `☐ ${i.text}`).join('\n') : '';
    bell(team(n), { kind: 'note', title: `Reminder: ${n.title || (n.body || '').split('\n')[0].slice(0, 80) || 'a note'}`, body: (n.title ? n.body || items : items).slice(0, 200) || null, link: '/notes', actor: null });
    tell(n);
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

  r.get('/labels', (req, res) => {
    const all = new Set();
    for (const n of q('SELECT labels FROM notes WHERE owner_id = ? OR id IN (SELECT note_id FROM note_shares WHERE user_id = ?)').all(req.user.id, req.user.id)) {
      for (const l of JSON.parse(n.labels || '[]')) all.add(l);
    }
    res.json([...all].sort((a, b) => a.localeCompare(b)));
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
  r.get('/:id/preview', (req, res) => {
    const n = load(req.params.id, req.user);
    if (n.trashed_at) throw notFound('Note not found');
    const items = n.items ? JSON.parse(n.items) : null;
    const body = n.body || '';
    res.json({
      id: n.id, title: n.title || '', color: n.color || null, archived: !!n.archived, mine: n.owner_id === req.user.id,
      owner_name: q('SELECT name FROM users WHERE id = ?').get(n.owner_id)?.name || null,
      body: items ? null : (body.length > 300 ? `${body.slice(0, 300)}…` : body),
      items: items ? { done: items.filter((i) => i.done).length, total: items.length, first: items.slice(0, 5).map((i) => ({ text: String(i.text || '').slice(0, 120), done: !!i.done })) } : null,
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

  // A copy as a document in your Drive: the title as a heading, text as paragraphs, a checklist as tick boxes.
  r.post('/:id/doc', (req, res) => {
    const n = load(req.params.id, req.user);
    const para = (text) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
    const items = n.items ? JSON.parse(n.items) : null;
    const content = [
      ...(n.title ? [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: n.title }] }] : []),
      ...(items ? (items.length ? [{ type: 'taskList', content: taskItems(items, para) }] : [])
        : String(n.body || '').split('\n').map((line) => para(line))),
    ];
    const json = JSON.stringify({ type: 'doc', content: content.length ? content : [para('')] });
    const id = insertFile({ owner: req.user.id, parentId: null, name: (n.title || (n.body || '').split('\n')[0] || 'Note').slice(0, 120), kind: 'doc', content: json, size: Buffer.byteLength(json) });
    res.status(201).json({ id });
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
