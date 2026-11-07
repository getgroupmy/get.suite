// Notes: quick notes and checklists on coloured cards. Pin the important ones, give them labels, archive
// what's done with, and share a note with colleagues to keep it together (everyone it's shared with can
// change it; only its owner can delete it). Mounted at /api/notes.
import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { sendTo } from '../hub.js';
import { notify as bell } from '../notifications.js';

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
if (!q('PRAGMA table_info(notes)').all().some((c) => c.name === 'remind_at')) q('ALTER TABLE notes ADD COLUMN remind_at INTEGER').run(); // a reminder, for everyone on the note

export const COLORS = ['#faafa8', '#f39f76', '#fff8b8', '#e2f6d3', '#b4ddd3', '#d4e4ed', '#aeccdc', '#d3bfdb', '#f6e2dd', '#e9e3d4', '#efeff1'];
const MAX_NOTES = 2000, MAX_ITEMS = 200, MAX_LABELS = 10;

/** Tidy a checklist from the client. */
export function cleanItems(list) {
  if (list === null) return null;
  if (!Array.isArray(list)) throw bad('items must be a list');
  return list.slice(0, MAX_ITEMS).map((it) => ({
    id: typeof it?.id === 'string' && /^[\w-]{1,40}$/.test(it.id) ? it.id : uid().slice(0, 12),
    text: String(it?.text ?? '').slice(0, 1000),
    done: !!it?.done,
  }));
}
export function cleanLabels(list) {
  if (!Array.isArray(list)) throw bad('labels must be a list');
  return [...new Set(list.map((l) => String(l ?? '').trim().slice(0, 40)).filter(Boolean))].slice(0, MAX_LABELS);
}

const team = (n) => [n.owner_id, ...q('SELECT user_id FROM note_shares WHERE note_id = ?').all(n.id).map((s) => s.user_id)];
function shape(n, me) {
  return {
    id: n.id, title: n.title, body: n.body, items: n.items ? JSON.parse(n.items) : null, color: n.color, pinned: !!n.pinned, archived: !!n.archived,
    labels: JSON.parse(n.labels || '[]'), remind_at: n.remind_at ?? null, position: n.position, created_at: n.created_at, updated_at: n.updated_at, mine: n.owner_id === me,
    owner: q('SELECT id, name, username FROM users WHERE id = ?').get(n.owner_id),
    shared: q(`SELECT u.id, u.name, u.username FROM note_shares s JOIN users u ON u.id = s.user_id WHERE s.note_id = ? ORDER BY u.name`).all(n.id),
  };
}
function load(id, user) {
  const n = q('SELECT * FROM notes WHERE id = ?').get(String(id));
  if (!n || (n.owner_id !== user.id && !q('SELECT 1 FROM note_shares WHERE note_id = ? AND user_id = ?').get(n.id, user.id))) throw notFound('Note not found');
  return n;
}
const tell = (n) => sendTo(team(n), { type: 'notes-changed' });

/** Send the reminders that are due (to everyone on each note), then clear them. */
export function remindNotesDue(at = now()) {
  const due = q('SELECT * FROM notes WHERE remind_at IS NOT NULL AND remind_at <= ? ORDER BY remind_at LIMIT 100').all(at);
  for (const n of due) {
    q('UPDATE notes SET remind_at = NULL WHERE id = ?').run(n.id);
    const items = n.items ? JSON.parse(n.items).filter((i) => !i.done).map((i) => `☐ ${i.text}`).join('\n') : '';
    bell(team(n), { kind: 'note', title: `Reminder: ${n.title || (n.body || '').split('\n')[0].slice(0, 80) || 'a note'}`, body: (n.title ? n.body || items : items).slice(0, 200) || null, link: '/notes', actor: null });
    tell(n);
  }
  return due.length;
}
export function startNotesScheduler() { setInterval(() => { try { remindNotesDue(); } catch (e) { console.error('[notes] reminders:', e.message); } }, 15e3).unref(); }

export default function noteRoutes() {
  const r = Router();

  // Yours and those shared with you: ?archived=1 for the archive, ?q= words to search, ?label= one label.
  r.get('/', (req, res) => {
    const archived = req.query.archived === '1' ? 1 : 0;
    let rows = q(`SELECT n.* FROM notes n WHERE (n.owner_id = ? OR n.id IN (SELECT note_id FROM note_shares WHERE user_id = ?)) AND n.archived = ?
                  ORDER BY n.pinned DESC, n.position DESC`).all(req.user.id, req.user.id, archived);
    const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      rows = rows.filter((n) => {
        const text = `${n.title} ${n.body} ${(n.items ? JSON.parse(n.items) : []).map((i) => i.text).join(' ')} ${JSON.parse(n.labels).join(' ')}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
    }
    if (req.query.reminders === '1') rows = q(`SELECT n.* FROM notes n WHERE (n.owner_id = ? OR n.id IN (SELECT note_id FROM note_shares WHERE user_id = ?)) AND n.remind_at IS NOT NULL
                                                ORDER BY n.remind_at`).all(req.user.id, req.user.id);
    if (req.query.label) rows = rows.filter((n) => JSON.parse(n.labels).includes(String(req.query.label)));
    res.json(rows.map((n) => shape(n, req.user.id)));
  });

  // Every label you use (on your notes and those shared with you), for the sidebar.
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
    const top = (q('SELECT MAX(position) AS p FROM notes WHERE owner_id = ?').get(req.user.id).p ?? 0) + 1;
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
    if (keys.length) q(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...keys.map((k) => set[k]), now(), req.user.id, n.id);
    const after = q('SELECT * FROM notes WHERE id = ?').get(n.id);
    tell(after);
    res.json(shape(after, req.user.id));
  });

  // Make a copy (yours, not shared).
  r.post('/:id/copy', (req, res) => {
    const n = load(req.params.id, req.user);
    const id = uid(), t = now();
    const top = (q('SELECT MAX(position) AS p FROM notes WHERE owner_id = ?').get(req.user.id).p ?? 0) + 1;
    q(`INSERT INTO notes (id, owner_id, title, body, items, color, pinned, labels, position, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, n.title, n.body, n.items, n.color, n.labels, top, t, t, req.user.id);
    const c = q('SELECT * FROM notes WHERE id = ?').get(id);
    tell(c);
    res.status(201).json(shape(c, req.user.id));
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

  // Delete (the owner), or take yourself off a note shared with you.
  r.delete('/:id', (req, res) => {
    const n = load(req.params.id, req.user);
    const before = team(n);
    if (n.owner_id === req.user.id) q('DELETE FROM notes WHERE id = ?').run(n.id);
    else q('DELETE FROM note_shares WHERE note_id = ? AND user_id = ?').run(n.id, req.user.id);
    sendTo(before, { type: 'notes-changed' });
    res.json({ ok: true, deleted: n.owner_id === req.user.id });
  });

  return r;
}
