// How much room someone's mail takes: each folder's size (STATUS SIZE), the total against their mailbox
// size limit (if an admin set one), and the largest messages, to delete what isn't needed.
import { q } from '../db.js';
import { withClient, ownConnection } from './imap.js';
import { notify } from '../notifications.js';
import { mailEnabled } from './config.js';

const BIG = 512 * 1024; // messages at least this big are candidates for "largest"
const PER_FOLDER = 300; // looked at per folder (the newest), so huge mailboxes stay quick
const SHOW = 25;

/** The largest of a list of messages ({ size }), biggest first, at most n. */
export const largestOf = (list, n = SHOW) => list.slice().sort((a, b) => b.size - a.size).slice(0, n);

/** The room one's limit leaves: { used, limit, percent } (limit and percent null without one). */
export function usage(used, limitMb) {
  const limit = limitMb ? limitMb * 1024 * 1024 : null;
  return { used, limit, percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : null };
}

export async function mailStorage(user) {
  return withClient(user, async (c) => {
    const boxes = (await c.list()).filter((b) => !b.flags?.has?.('\\Noselect'));
    const folders = [];
    const big = [];
    for (const b of boxes) {
      const name = b.path === 'INBOX' ? 'Inbox' : b.name;
      // The folder this pooled connection has open answers from what it last synced: catch up first.
      if (c.mailbox && c.mailbox.path === b.path) await c.noop();
      const st = await c.status(b.path, { messages: true, size: true });
      folders.push({ path: b.path, name, special: b.specialUse || null, messages: st.messages || 0, size: st.size || 0 });
      if (!st.messages || (st.size || 0) < BIG) continue;
      const lock = await c.getMailboxLock(b.path, { readOnly: true });
      try {
        const uids = ((await c.search({ larger: BIG }, { uid: true })) || []).slice(-PER_FOLDER);
        if (uids.length) {
          for await (const m of c.fetch(uids.join(','), { uid: true, size: true, envelope: true, internalDate: true, bodyStructure: true }, { uid: true })) {
            const from = m.envelope?.from?.[0];
            big.push({ folder: b.path, folder_name: name, folder_special: b.specialUse || null, uid: m.uid, size: m.size, subject: m.envelope?.subject || '', from: from ? { name: from.name || '', email: from.address || '' } : null,
              date: (m.envelope?.date || m.internalDate)?.getTime?.() ?? null, attachments: !!m.bodyStructure?.childNodes?.some((n) => n.disposition === 'attachment') });
          }
        }
      } finally { lock.release(); }
    }
    const used = folders.reduce((n, f) => n + f.size, 0);
    const limitMb = q('SELECT mail_quota_mb FROM users WHERE id = ?').get(user.id)?.mail_quota_mb || null;
    return { ...usage(used, limitMb), folders: folders.sort((a, b) => b.size - a.size), largest: largestOf(big), big_from: BIG };
  });
}

/** Just the total, folder by folder (quick: no looking for large messages). */
export async function mailUsed(user) {
  return withClient(user, async (c) => {
    let used = 0;
    for (const b of (await c.list()).filter((x) => !x.flags?.has?.('\\Noselect'))) {
      if (c.mailbox && c.mailbox.path === b.path) await c.noop();
      used += (await c.status(b.path, { size: true })).size || 0;
    }
    return used;
  });
}

// A warning when someone's mailbox (with a size limit) is nearly full, and again when it's full: new mail
// is sent back once it is. Each level once, until it drops back below 90%.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_full_told')) q('ALTER TABLE users ADD COLUMN mail_full_told INTEGER').run(); // 90 or 100: told about that level
export const FULL_LEVELS = [90, 100];
/** The level to tell someone about now (90 or 100), or null: nothing new, or back below 90% (forget what was told). */
export function fullLevel(percent, told) {
  const level = [...FULL_LEVELS].reverse().find((l) => percent >= l) ?? null;
  if (level === null) return { tell: null, told: null };
  return { tell: told && told >= level ? null : level, told: Math.max(level, told || 0) };
}
export async function checkMailboxesFull() {
  if (!mailEnabled()) return 0;
  let n = 0;
  for (const u of q('SELECT * FROM users WHERE mail_quota_mb > 0 AND disabled = 0').all()) {
    try { if (await checkFull(u)) n++; } catch (e) { console.error('[mail] mailbox full check:', e.message); }
  }
  return n;
}
/** Check one person (with a limit) now; true when they were told something. */
export async function checkFull(u) {
  if (!mailEnabled() || !(u.mail_quota_mb > 0) || u.disabled) return false;
  const { percent } = usage(await mailUsed(u), u.mail_quota_mb);
  const { tell, told } = fullLevel(percent, u.mail_full_told);
  q('UPDATE users SET mail_full_told = ? WHERE id = ?').run(told, u.id);
  if (!tell) return false;
  notify([u.id], tell >= 100
    ? { kind: 'mailfull', title: 'Your mailbox is full', body: 'New email is being sent back to whoever wrote it. Delete large messages or empty Trash to make room.', link: '/mail?storage=1' }
    : { kind: 'mailfull', title: `Your mailbox is ${percent}% full`, body: 'When it’s full, new email is sent back. Mail → Storage shows what takes the room.', link: '/mail?storage=1' });
  return true;
}
export function scheduleFullChecks() { setInterval(() => checkMailboxesFull().catch((e) => console.error('[mail] full:', e.message)), 3600e3).unref(); }

/** Someone's mail total on a connection of its own (for looking at many people at once; closed after). */
async function usedOnOwn(user) {
  const c = await ownConnection(user);
  try {
    let used = 0;
    for (const b of (await c.list()).filter((x) => !x.flags?.has?.('\\Noselect'))) used += (await c.status(b.path, { size: true })).size || 0;
    return used;
  } finally { await c.logout().catch(() => {}); }
}

const companyCache = new Map(); // org id -> { at, value }
const COMPANY_TTL = 10 * 60e3;
/**
 * Everyone's mailbox in a company: { people: [{ id, name, username, used, limit, percent, error? }], used, checked_at },
 * fullest first (by share of their limit, then size). Looked up a few at a time, and kept for 10 minutes.
 */
export async function companyMail(orgId, { fresh = false, now = Date.now() } = {}) {
  const hit = companyCache.get(orgId);
  if (!fresh && hit && now - hit.at < COMPANY_TTL) return hit.value;
  const users = q('SELECT id, name, username, mail_quota_mb FROM users WHERE org_id = ? AND disabled = 0 ORDER BY name').all(orgId);
  const people = [];
  for (let i = 0; i < users.length; i += 4) {
    people.push(...await Promise.all(users.slice(i, i + 4).map(async (u) => {
      try { return { id: u.id, name: u.name, username: u.username, ...usage(await usedOnOwn(u), u.mail_quota_mb || null) }; }
      catch { return { id: u.id, name: u.name, username: u.username, ...usage(0, u.mail_quota_mb || null), used: null, error: 'Couldn’t be read' }; }
    })));
  }
  people.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || (b.used ?? 0) - (a.used ?? 0));
  const value = { people, used: people.reduce((n, p) => n + (p.used || 0), 0), checked_at: now };
  companyCache.set(orgId, { at: now, value });
  return value;
}
