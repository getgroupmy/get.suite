// "Undo changes" in Contacts: each contact's earlier state is logged (by SQLite triggers, so changes from
// Contacts, imports, merges and phones over CardDAV all count) for HISTORY_DAYS, and someone's contacts can
// be put back as they were at an earlier time: changed ones back as they were, ones made since then moved
// to the trash, ones deleted since then back (from the trash, with their photo, while it has them).
import { q } from './db.js';
import { trashContact, restoreContact } from './contacttrash.js';

export const HISTORY_DAYS = 30;
q(`CREATE TABLE IF NOT EXISTS contact_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  before TEXT                -- the row as JSON before the change; NULL when the change made it
)`).run();
q('CREATE INDEX IF NOT EXISTS contact_history_owner ON contact_history (owner_id, at)').run();

const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
/** (Re)make the triggers for the contacts table's columns as they are now (other modules add columns). */
export function watchContacts() {
  const cols = q('PRAGMA table_info(contacts)').all().map((c) => c.name);
  const row = (p) => `json_object(${cols.map((c) => `'${c}', ${p}.${c}`).join(', ')})`;
  q('DROP TRIGGER IF EXISTS contacts_hist_ins').run();
  q('DROP TRIGGER IF EXISTS contacts_hist_upd').run();
  q('DROP TRIGGER IF EXISTS contacts_hist_del').run();
  q(`CREATE TRIGGER contacts_hist_ins AFTER INSERT ON contacts BEGIN
       INSERT INTO contact_history (owner_id, contact_id, at, before) VALUES (NEW.owner_id, NEW.id, ${NOW_MS}, NULL); END`).run();
  q(`CREATE TRIGGER contacts_hist_upd AFTER UPDATE ON contacts BEGIN
       INSERT INTO contact_history (owner_id, contact_id, at, before) VALUES (OLD.owner_id, OLD.id, ${NOW_MS}, ${row('OLD')}); END`).run();
  q(`CREATE TRIGGER contacts_hist_del AFTER DELETE ON contacts BEGIN
       INSERT INTO contact_history (owner_id, contact_id, at, before) VALUES (OLD.owner_id, OLD.id, ${NOW_MS}, ${row('OLD')}); END`).run();
}

export function sweepContactHistory(at = Date.now()) {
  return q('DELETE FROM contact_history WHERE at < ?').run(at - HISTORY_DAYS * 86400000).changes;
}

/** How many contacts have changed since `since` (for the confirmation). */
export function changedSince(userId, since) {
  return q('SELECT COUNT(DISTINCT contact_id) AS n FROM contact_history WHERE owner_id = ? AND at > ?').get(userId, since).n;
}

/** Put someone's contacts back as they were at `to`. Returns how many contacts it changed. */
export function undoContacts(userId, to) {
  const earliest = q(`SELECT h.contact_id, h.before FROM contact_history h
                      WHERE h.owner_id = ? AND h.at > ? AND h.seq = (SELECT MIN(seq) FROM contact_history x WHERE x.contact_id = h.contact_id AND x.at > ?)`).all(userId, to, to);
  const cols = q('PRAGMA table_info(contacts)').all().map((c) => c.name);
  let n = 0;
  // (one contact at a time: moving to and from the trash makes transactions of their own)
  for (const { contact_id: id, before } of earliest) {
    const exists = !!q('SELECT 1 FROM contacts WHERE id = ?').get(id);
    if (before === null) { if (exists && trashContact(id, userId)) n++; continue; } // made since then
    const was = JSON.parse(before);
    const keep = cols.filter((c) => c in was && c !== 'id');
    if (!exists) restoreContact(id, userId); // back from the trash, with its photo, if it's there
    if (q('SELECT 1 FROM contacts WHERE id = ?').get(id)) {
      q(`UPDATE contacts SET ${keep.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...keep.map((c) => was[c]), id);
    } else {
      q(`INSERT INTO contacts (id, ${keep.join(', ')}) VALUES (?, ${keep.map(() => '?').join(', ')})`).run(id, ...keep.map((c) => was[c]));
    }
    n++;
  }
  return n;
}
