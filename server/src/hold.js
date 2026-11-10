// Legal hold (admins): while a person is on hold, nothing of theirs is deleted for good: not by the
// automatic clean-ups (Drive's trash, Chat's keeping period, Mail's Trash and Junk), and not by anyone
// deleting it for good by hand (they can still move things to the trash, which keeps them). Their
// account can't be deleted either. Kept on users.legal_hold (with who set it, when and why).
import { q, db } from './db.js';
import { HttpError } from './util.js';

const cols = q('PRAGMA table_info(users)').all().map((c) => c.name);
for (const [col, type] of [['legal_hold', 'INTEGER NOT NULL DEFAULT 0'], ['hold_note', 'TEXT'], ['hold_at', 'INTEGER'], ['hold_by', 'TEXT']]) {
  if (!cols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
}

export const onHold = (userId) => !!userId && !!q('SELECT legal_hold FROM users WHERE id = ?').get(userId)?.legal_hold;

/** Throws (409) when what's about to be deleted for good belongs to someone on hold. */
export function keepIfHeld(userId, what = 'This') {
  if (onHold(userId)) throw new HttpError(409, `${what} can't be deleted for good while your company is keeping it (a legal hold).`);
}

/** Put someone on hold (with a note saying why), or take them off. */
export function setHold(userId, hold, { note = null, by = null } = {}) {
  if (hold) q('UPDATE users SET legal_hold = 1, hold_note = ?, hold_at = ?, hold_by = ? WHERE id = ?').run(note, Date.now(), by, userId);
  else q('UPDATE users SET legal_hold = 0, hold_note = NULL, hold_at = NULL, hold_by = NULL WHERE id = ?').run(userId);
}
