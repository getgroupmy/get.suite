// Shared mailboxes: an address such as support@ or info@ with its own mailbox, which the people an
// admin chooses read and answer from Mail. Nobody signs in as it: its password can never match, so
// only Workspace's webmail login (on a member's behalf) opens it.
import { q } from '../db.js';

q(`CREATE TABLE IF NOT EXISTS shared_mailboxes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS shared_mailbox_members (
  mailbox_id TEXT NOT NULL REFERENCES shared_mailboxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (mailbox_id, user_id)
)`).run();

export const allSharedMailboxes = () => q('SELECT * FROM shared_mailboxes ORDER BY address').all();
export const isSharedAddress = (address) => !!q('SELECT 1 FROM shared_mailboxes WHERE address = ?').get(String(address).toLowerCase());
/** The shared mailboxes this person may use (in their own company). */
export const sharedMailboxesFor = (user) => q(`SELECT s.id, s.address, s.name FROM shared_mailboxes s JOIN shared_mailbox_members m ON m.mailbox_id = s.id
                                                WHERE m.user_id = ? AND s.org_id = ? ORDER BY s.address`).all(user.id, user.org_id);
/** One of them, if this person is a member. */
export const sharedMailboxFor = (user, id) => q(`SELECT s.* FROM shared_mailboxes s JOIN shared_mailbox_members m ON m.mailbox_id = s.id
                                                 WHERE s.id = ? AND m.user_id = ? AND s.org_id = ?`).get(String(id), user.id, user.org_id) || null;
// Who answers what: a message (by Message-ID) in a shared mailbox given to one of its members, and
// whether it's done.
q(`CREATE TABLE IF NOT EXISTS shared_assignments (
  mailbox_id TEXT NOT NULL REFERENCES shared_mailboxes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  done INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox_id, message_id)
)`).run();
/** Assignments for some messages of a mailbox: Map(messageId -> { assignee: { id, name } | null, done, by_name }). */
export function assignmentsOf(mailboxId, messageIds) {
  const out = new Map();
  const ids = [...new Set(messageIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const a of q(`SELECT a.message_id, a.assignee_id, a.done, u.name AS assignee_name, b.name AS by_name FROM shared_assignments a
                       LEFT JOIN users u ON u.id = a.assignee_id LEFT JOIN users b ON b.id = a.updated_by
                       WHERE a.mailbox_id = ? AND a.message_id IN (${chunk.map(() => '?').join(',')})`).all(mailboxId, ...chunk)) {
      out.set(a.message_id, { assignee: a.assignee_id ? { id: a.assignee_id, name: a.assignee_name } : null, done: !!a.done, by_name: a.by_name });
    }
  }
  return out;
}

// Internal notes on a message: a short discussion only the mailbox's people see (never sent to the customer).
q(`CREATE TABLE IF NOT EXISTS shared_notes (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES shared_mailboxes(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS shared_notes_msg ON shared_notes(mailbox_id, message_id, created_at)').run();
export const notesOf = (mailboxId, messageId) => q(`SELECT n.id, n.body, n.created_at, n.user_id, u.name AS user_name FROM shared_notes n LEFT JOIN users u ON u.id = n.user_id
                                                     WHERE n.mailbox_id = ? AND n.message_id = ? ORDER BY n.created_at`).all(mailboxId, messageId);
/** How many notes each message has: Map(messageId -> n). */
export function noteCounts(mailboxId, messageIds) {
  const out = new Map();
  const ids = [...new Set(messageIds.filter(Boolean))].slice(0, 500);
  if (!ids.length) return out;
  for (const r of q(`SELECT message_id, COUNT(*) AS n FROM shared_notes WHERE mailbox_id = ? AND message_id IN (${ids.map(() => '?').join(',')}) GROUP BY message_id`).all(mailboxId, ...ids)) out.set(r.message_id, r.n);
  return out;
}

export const membersOf = (id) => q(`SELECT u.id, u.name, u.username FROM shared_mailbox_members m JOIN users u ON u.id = m.user_id WHERE m.mailbox_id = ? ORDER BY u.name`).all(id);
