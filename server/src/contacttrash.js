// Contacts' trash: a deleted contact (in Contacts, several at once, or from a phone over CardDAV) is
// kept here for TRASH_DAYS with its photo, and can be put back as it was, under the same id (so groups
// and anything else pointing at it still do). After that it's gone for good.
import { q, tx } from './db.js';

q(`CREATE TABLE IF NOT EXISTS contacts_trash (
  id TEXT PRIMARY KEY,               -- the contact's own id
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted_by TEXT,
  row TEXT NOT NULL,                 -- the contact's row as JSON
  photo BLOB, photo_mime TEXT,
  deleted_at INTEGER NOT NULL
)`).run();

export const TRASH_DAYS = 30;

/** Delete a contact, keeping it in the trash. */
export function trashContact(id, byUserId) {
  const row = q('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!row) return false;
  const photo = q('SELECT data, mime FROM contact_photos WHERE contact_id = ?').get(id);
  tx(() => {
    q(`INSERT INTO contacts_trash (id, owner_id, deleted_by, row, photo, photo_mime, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET row = excluded.row, photo = excluded.photo, photo_mime = excluded.photo_mime, deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`)
      .run(id, row.owner_id, byUserId || null, JSON.stringify(row), photo?.data || null, photo?.mime || null, Date.now());
    q('DELETE FROM contacts WHERE id = ?').run(id);
  });
  return true;
}

/** What someone sees in their trash: contacts they own, or a company contact they deleted. Newest first. */
export function trashOf(userId) {
  return q(`SELECT id, owner_id, deleted_by, row, photo IS NOT NULL AS has_photo, deleted_at FROM contacts_trash
            WHERE owner_id = ? OR deleted_by = ? ORDER BY deleted_at DESC`).all(userId, userId).map((t) => {
    const r = JSON.parse(t.row);
    return { id: t.id, name: r.name, email: r.email || null, phone: r.phone || null, company: r.company || null, has_photo: !!t.has_photo,
      deleted_at: t.deleted_at, gone_at: t.deleted_at + TRASH_DAYS * 86400000, mine: t.owner_id === userId };
  });
}

const mayRestore = (t, userId) => t && (t.owner_id === userId || t.deleted_by === userId);

/** Put a contact back as it was. Returns its id, or null if it isn't in this person's trash. */
export function restoreContact(id, userId) {
  const t = q('SELECT * FROM contacts_trash WHERE id = ?').get(id);
  if (!mayRestore(t, userId)) return null;
  if (!q('SELECT 1 FROM users WHERE id = ?').get(t.owner_id)) return null;
  const row = JSON.parse(t.row);
  const cols = q('PRAGMA table_info(contacts)').all().map((c) => c.name).filter((c) => c in row);
  tx(() => {
    if (!q('SELECT 1 FROM contacts WHERE id = ?').get(id)) {
      q(`INSERT INTO contacts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      if (t.photo) q('INSERT OR REPLACE INTO contact_photos (contact_id, data, mime, updated_at) VALUES (?, ?, ?, ?)').run(id, t.photo, t.photo_mime, Date.now());
    }
    q('DELETE FROM contacts_trash WHERE id = ?').run(id);
  });
  return id;
}

/** Delete for good: one, or (no id) everything in this person's trash. Returns how many. */
export function purgeTrash(userId, id = null) {
  if (id) {
    const t = q('SELECT * FROM contacts_trash WHERE id = ?').get(id);
    if (!mayRestore(t, userId)) return 0;
    return q('DELETE FROM contacts_trash WHERE id = ?').run(id).changes;
  }
  return q('DELETE FROM contacts_trash WHERE owner_id = ? OR deleted_by = ?').run(userId, userId).changes;
}

/** Forget what has been in the trash longer than TRASH_DAYS (run now and then). */
export function sweepContactTrash(now = Date.now()) {
  return q('DELETE FROM contacts_trash WHERE deleted_at < ?').run(now - TRASH_DAYS * 86400000).changes;
}
