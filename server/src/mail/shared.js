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
export const membersOf = (id) => q(`SELECT u.id, u.name, u.username FROM shared_mailbox_members m JOIN users u ON u.id = m.user_id WHERE m.mailbox_id = ? ORDER BY u.name`).all(id);
