import { companySignature, companySignatureFor } from '../mail/companysig.js';
import { notify as notifyBell } from '../notifications.js';
import { audit } from '../audit.js';
import crypto from 'node:crypto';
import { fillTemplate, mergeHtml, unknownPlaceholders } from '../mail/merge.js';
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { q, FILES_DIR, DATA_DIR } from '../db.js';
import { sendTo } from '../hub.js';
import { str, bad, notFound, HttpError, uid as newId, now } from '../util.js';
import { keepIfHeld } from '../hold.js';
import { checkMessage, describeHits } from '../dlp.js';
import { parseMaillog, readMaillog, deliveryOf } from '../mail/maillog.js';
import { roleFor, mayTakeAway } from '../access.js';
import { mailEnabled, scheduleMailConfig, MAIL_HOSTNAME } from '../mail/config.js';
import { withClient, withFolder, smtpFor } from '../mail/imap.js';
import { normalizeRules, cleanMessageId } from '../mail/sieve.js';
import { sharedMailboxesFor, sharedMailboxFor, assignmentsOf, notesOf, noteCounts, membersOf as sharedMembers, delegatedMailboxesFor, delegatedMailboxFor, delegatesOf, MAX_DELEGATES } from '../mail/shared.js';
import { followedFolders, setFollowed, MAX_FOLLOWED } from '../mail/notify.js';
import { forwardHtml } from '../mail/forwardhtml.js';
import { unsubscribeOptions, oneClickUnsubscribe } from '../mail/unsubscribe.js';
import { groupSubscriptions } from '../mail/subscriptions.js';
import { baseSubject, shareSomeone } from '../mail/thread.js';
import { startImport, startMboxImport, importOf } from '../mail/importer.js';
import { insertFile, cleanName } from './files.js';
import { checkQuota } from '../tenancy.js';
import { recordSent } from '../othercontacts.js';
import { confidentialRoutes, setCodeSender, newToken, noticeOf, keepConfidential, EXPIRY_DAYS } from '../mail/confidential.js';
import { baseUrl as publicBase } from './calendar.js';
import { parseMailQuery, allOf } from '../mail/searchquery.js';
import { tabQuery, TABS, TO_PRIMARY, TO_UPDATES } from '../mail/tabs.js';
import { receiptRequest, buildReceipt } from '../mail/receipt.js';
import { mimeFor } from '../util.js';
import { previewMime, previewHeaders } from '../mail/preview.js';
import { officePreview } from '../office/preview.js';
import { originalSummary } from '../mail/original.js';
import { zipEntries } from '../zipfiles.js';
import { calendarPartOf, readInvite, replyIcs, eventForInvite, saveInvite, readReply } from '../mail/invite.js';
import { recordReply } from '../mail/invitereply.js';
import { setVacation } from '../mail/vacation.js';
import { touch as eventsChanged } from './calendar.js';

// Saved searches (Mail sidebar → Searches).
q(`CREATE TABLE IF NOT EXISTS mail_searches (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, folder TEXT NOT NULL, query TEXT NOT NULL, position REAL NOT NULL, created_at INTEGER NOT NULL
)`).run();
// Inbox tabs: on for everyone unless they turn them off.
if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'inbox_tabs')) q('ALTER TABLE users ADD COLUMN inbox_tabs INTEGER NOT NULL DEFAULT 1').run();
const inboxTabsOn = (userId) => !!q('SELECT inbox_tabs FROM users WHERE id = ?').get(userId)?.inbox_tabs;

const PAGE = 50;
const OUTBOX = path.join(DATA_DIR, 'outbox');
const MAX_SCHEDULED = 100;
const MAX_MERGE = 200; // messages per mail merge
q(`CREATE TABLE IF NOT EXISTS scheduled_mail (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  send_at INTEGER NOT NULL,
  envelope TEXT NOT NULL,           -- JSON { from, to: [addresses] }
  subject TEXT,
  recipients TEXT,                  -- JSON: names or addresses, for the list
  reply_to TEXT,                    -- JSON { folder, uid } of the message answered
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,             -- scheduled | failed
  tries INTEGER NOT NULL DEFAULT 0,
  error TEXT
)`).run();

q(`CREATE TABLE IF NOT EXISTS mail_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT,
  html TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`).run();

// Labels: your own coloured tags for messages, kept on the mail server as IMAP keywords (so mail
// apps that show keywords, such as Thunderbird's tags, see them). Names and colours are kept here.
q(`CREATE TABLE IF NOT EXISTS mail_labels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
const MAX_LABELS = 100;
const LABEL_COLORS = ['#1a73e8', '#0b8043', '#d50000', '#f4511e', '#f6bf26', '#8e24aa', '#039be5', '#616161'];
const labelsOf = (userId) => q('SELECT id, name, color, keyword FROM mail_labels WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId);

// Snoozed mail waits in a "Snoozed" IMAP folder (so phones see where it went) and comes back to
// the Inbox, unread, when it's due. The message is found again by its Message-ID, or its UID.
export const SNOOZED = 'Snoozed';
const MAX_SNOOZE_MS = 366 * 864e5;
q(`CREATE TABLE IF NOT EXISTS snoozed_mail (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,             -- in the Snoozed folder
  message_id TEXT,
  subject TEXT,
  until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS snoozed_mail_due ON snoozed_mail(until)').run();

/** Move snoozed messages (rows of snoozed_mail, one user's) back to the Inbox, unread. */
async function wake(user, rows) {
  await withFolder(user, SNOOZED, async (c) => {
    for (const row of rows) {
      let uids = row.message_id ? (await c.search({ header: { 'message-id': row.message_id } }, { uid: true })) || [] : [];
      if (!uids.length) uids = ((await c.search({ uid: String(row.uid) }, { uid: true })) || []);
      if (uids.length) {
        await c.messageFlagsRemove(uids.join(','), ['\\Seen'], { uid: true });
        await c.messageMove(uids.join(','), 'INBOX', { uid: true });
      }
      q('DELETE FROM snoozed_mail WHERE id = ?').run(row.id);
    }
  }).catch((e) => {
    if (e.status !== 404) throw e;
    q(`DELETE FROM snoozed_mail WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id)); // the folder is gone
  });
  sendTo([user.id], { type: 'mail-snoozed' });
}

/** Messages taken out of Snoozed by hand don't come back. */
function forgetSnoozes(user, folder, uids) {
  if (folder !== SNOOZED) return;
  const list = String(uids).split(',').map(Number);
  q(`DELETE FROM snoozed_mail WHERE user_id = ? AND uid IN (${list.map(() => '?').join(',')})`).run(user.id, ...list);
}

let waking = false;
/** Bring back the snoozed messages that are due. */
export async function wakeDue() {
  if (waking) return 0;
  waking = true;
  let n = 0;
  try {
    const due = q('SELECT * FROM snoozed_mail WHERE until <= ? ORDER BY until LIMIT 200').all(Date.now());
    const byUser = new Map();
    for (const row of due) byUser.set(row.user_id, [...(byUser.get(row.user_id) || []), row]);
    for (const [userId, rows] of byUser) {
      const user = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(userId);
      if (!user) continue; // a disabled account's snoozes wait until it's back
      try { await wake(user, rows); n += rows.length; } catch (e) { console.error('[mail] snooze:', e.message); }
    }
  } finally { waking = false; }
  return n;
}

/** Hand a built message to the mail server, keep a copy in Sent, and mark the message answered. */
async function deliver(user, raw, envelope, { replyTo } = {}) {
  try {
    await smtpFor(user).sendMail({ envelope, raw });
  } catch (e) {
    throw new HttpError(e.responseCode && e.responseCode < 500 ? 503 : 400, `Sending failed: ${e.response || e.message}`);
  }
  const sent = await specialOf(user, '\\Sent').catch(() => null);
  if (sent) await withClient(user, (c) => c.append(sent, raw, ['\\Seen'])).catch(() => {});
  if (replyTo?.folder && replyTo?.uid) {
    await withFolder(user, String(replyTo.folder), (c) => c.messageFlagsAdd(String(Number(replyTo.uid)), ['\\Answered'], { uid: true })).catch(() => {});
  }
}

/** The message's Date header set to now (it was built when it was scheduled). */
export function redate(raw, date = new Date()) {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const stamp = date.toUTCString().replace('GMT', '+0000');
  const next = /^Date:.*$/im.test(head) ? head.replace(/^Date:.*(\r?\n[ \t].*)*$/im, `Date: ${stamp}`) : `Date: ${stamp}\r\n${head}`;
  return Buffer.concat([Buffer.from(next, 'latin1'), raw.subarray(Buffer.byteLength(head, 'latin1'))]);
}

// Follow-ups: "remind me if nobody replies" on a sent message. When it's due, the person's folders
// (not Sent, Drafts, Junk or Trash) are searched for a reply to it (In-Reply-To or References); if
// there's none, a notification says so. Replies on the way cancel nothing early; it's checked when due.
q(`CREATE TABLE IF NOT EXISTS mail_followups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  subject TEXT,
  recipients TEXT,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
const FOLLOW_UP_DAYS = [1, 2, 3, 7, 14];
/** The Message-ID header of a built message. */
export function messageIdOf(raw) {
  const head = raw.toString('latin1').split(/\r?\n\r?\n/)[0];
  return (/^Message-ID:\s*(<[^>\r\n]+>)/im.exec(head) || [])[1] || null;
}
function addFollowUp(user, raw, { subject, to }, days, from = Date.now()) {
  const d = Number(days);
  if (!FOLLOW_UP_DAYS.includes(d)) throw bad('Choose when to be reminded');
  const mid = messageIdOf(raw);
  if (!mid) return null;
  const id = newId();
  q('INSERT INTO mail_followups (id, user_id, message_id, subject, recipients, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, mid, subject || '', JSON.stringify(to || []), from + d * 864e5, Date.now());
  return id;
}
/** Has anything in the person's mailbox (other than what they sent or binned) replied to this message? */
async function hasReply(user, messageId) {
  return withClient(user, async (c) => {
    const skip = new Set(['\\Sent', '\\Drafts', '\\Junk', '\\Trash']);
    for (const f of await c.list()) {
      if (f.flags?.has?.('\\Noselect') || skip.has(f.specialUse)) continue;
      const lock = await c.getMailboxLock(f.path).catch(() => null);
      if (!lock) continue;
      try {
        const a = (await c.search({ header: { 'in-reply-to': messageId } }, { uid: true })) || [];
        const b = a.length ? a : (await c.search({ header: { references: messageId } }, { uid: true })) || [];
        if (b.length) return true;
      } finally { lock.release(); }
    }
    return false;
  });
}
let following = false;
/** Check the follow-ups that are due: tell the sender about the ones nobody has answered. */
export async function checkFollowUps(at = Date.now()) {
  if (following) return 0;
  following = true;
  let told = 0;
  try {
    for (const row of q('SELECT * FROM mail_followups WHERE due_at <= ? ORDER BY due_at LIMIT 50').all(at)) {
      const user = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(row.user_id);
      if (!user) continue;
      let replied;
      try { replied = await hasReply(user, row.message_id); } catch (e) { console.error('[mail] follow-up:', e.message); continue; }
      q('DELETE FROM mail_followups WHERE id = ?').run(row.id);
      if (replied) continue;
      const to = JSON.parse(row.recipients || '[]');
      const days = Math.max(1, Math.round((row.due_at - row.created_at) / 864e5));
      notifyBell([user.id], { kind: 'followup', title: `No reply yet: “${row.subject || '(no subject)'}”`, body: `Sent to ${to.slice(0, 3).join(', ')}${to.length > 3 ? ` and ${to.length - 3} more` : ''} ${days} day${days === 1 ? '' : 's'} ago`, link: `/mail?open=${encodeURIComponent(row.message_id)}`, actor: null });
      sendTo([user.id], { type: 'mail-followups' });
      told++;
    }
  } finally { following = false; }
  return told;
}

let sending = false;
/** Send the scheduled messages that are due (tried three times, a few minutes apart, before giving up). */
export async function sendDue() {
  if (sending) return 0;
  sending = true;
  let n = 0;
  try {
    const due = q("SELECT * FROM scheduled_mail WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT 20").all(Date.now());
    for (const row of due) {
      const user = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(row.user_id);
      const file = path.join(OUTBOX, `${row.id}.eml`);
      if (!user || !fs.existsSync(file)) { q("UPDATE scheduled_mail SET status = 'failed', error = ? WHERE id = ?").run(user ? 'The message was lost' : 'The account is disabled', row.id); continue; }
      try {
        await deliver(user, redate(fs.readFileSync(file)), JSON.parse(row.envelope), { replyTo: row.reply_to ? JSON.parse(row.reply_to) : null });
        q('DELETE FROM scheduled_mail WHERE id = ?').run(row.id);
        fs.rm(file, { force: true }, () => {});
        n++;
      } catch (e) {
        const tries = row.tries + 1;
        if (tries >= 3) q("UPDATE scheduled_mail SET status = 'failed', tries = ?, error = ? WHERE id = ?").run(tries, e.message, row.id);
        else q('UPDATE scheduled_mail SET tries = ?, send_at = ?, error = ? WHERE id = ?').run(tries, Date.now() + tries * 5 * 6e4, e.message, row.id);
      }
      sendTo([row.user_id], { type: 'mail-scheduled' });
    }
  } finally { sending = false; }
  return n;
}
export function startScheduledSending() {
  setInterval(() => {
    sendDue().catch((e) => console.error('[mail] scheduled sending:', e.message));
    wakeDue().catch((e) => console.error('[mail] snooze:', e.message));
    checkFollowUps().catch((e) => console.error('[mail] follow-ups:', e.message));
  }, 20e3).unref();
}
const MAX_SEND_BYTES = 25 * 1024 * 1024;
const LINK_DAYS = 30; // large files sent as links: how long the links last
const ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const addr = (a) => (a ? { name: a.name || '', address: (a.address || '').toLowerCase() } : null);
const addrList = (field) => (field?.value || []).flatMap((a) => (a.group ? a.group : [a])).map(addr);

/** Addresses this user may send as: their own, plus aliases they belong to. */
function identities(user) {
  const out = [{ address: user.username, name: user.name }];
  for (const a of q('SELECT address, targets FROM aliases WHERE org_id = ?').all(user.org_id)) {
    if (a.targets.split(',').includes(user.username)) out.push({ address: a.address, name: user.name });
  }
  return out;
}

/**
 * Data protection rules (Admin → Data protection) for a message about to go: a rule that blocks stops it
 * (400); one that warns stops it with 409 and what it found until the sender confirms (confirmed: true),
 * which is logged. Gives true when the response has been sent.
 */
function dataRulesStop(req, res, { recipients, subject, text, html, confirmed }) {
  const ours = new Set(q('SELECT name FROM domains WHERE org_id = ?').all(req.user.org_id).map((d) => d.name.toLowerCase()));
  const outside = recipients.some((a) => !ours.has(String(a).split('@')[1]?.toLowerCase()));
  const hits = checkMessage(req.user.org_id, { subject, text, html }, outside);
  const target = String(subject || '').slice(0, 120) || '(no subject)';
  if (hits.block.length) {
    audit(req, 'dlp.blocked', { target, details: { rules: hits.block.map((h) => h.rule.name), recipients: recipients.length } });
    res.status(400).json({ error: `This message can’t be sent: it contains ${describeHits(hits.block)}. Your company doesn’t allow that${outside ? ' outside the company' : ''}.`, dlp: { block: hits.block } });
    return true;
  }
  if (hits.warn.length && !confirmed) {
    res.status(409).json({ error: `This message contains ${describeHits(hits.warn)}.`, dlp: { warn: hits.warn } });
    return true;
  }
  if (hits.warn.length) audit(req, 'dlp.sent_anyway', { target, details: { rules: hits.warn.map((h) => h.rule.name), recipients: recipients.length } });
  return false;
}

function parseRecipients(value, label) {
  const list = addressparser(String(value || ''), { flatten: true })
    .map((a) => ({ name: a.name || '', address: (a.address || '').trim().toLowerCase() }))
    .filter((a) => a.address);
  for (const a of list) if (!EMAIL_RE.test(a.address)) throw bad(`${label}: “${a.address}” is not a valid email address`);
  return list;
}

const specialOf = (user, use) => withClient(user, (c) => specialFolder(c, use));

async function specialFolder(client, use) {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === use)?.path || null;
}

function uidList(v) {
  const arr = (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!arr.length) throw bad('No messages selected');
  return arr;
}

export default function webmailRoutes() {
  const r = Router();

  r.get('/status', (req, res) => res.json({
    enabled: mailEnabled(), address: req.user.username, identities: identities(req.user), vacation: vacationOf(req.user.id),
    shared: mailEnabled() ? [...sharedMailboxesFor(req.user), ...delegatedMailboxesFor(req.user)] : [], // shared mailboxes this person reads and answers, and colleagues' mail delegated to them
  }));

  r.use((req, res, next) => (mailEnabled() ? next() : next(new HttpError(503, 'Email is not set up on this server'))));
  // Confidential mode: codes for outside recipients come by email from the sender.
  setCodeSender((to, { code, fromUser, subject }) => smtpFor(fromUser).sendMail({
    from: { name: fromUser.name, address: fromUser.username }, to,
    subject: `Your code to read “${String(subject || 'a confidential message').slice(0, 100)}”`,
    text: `Your code is ${code}\n\nType it on the page to read the confidential message ${fromUser.name} sent you. It works for 10 minutes, once.`,
  }));
  r.use('/confidential', confidentialRoutes());

  // Unread mail in the Inbox of each shared mailbox you're in (for the Mailbox picker): [{ id, unseen }].
  r.get('/shared-unread', async (req, res) => {
    const out = [];
    for (const mb of [...sharedMailboxesFor(req.user), ...delegatedMailboxesFor(req.user)]) {
      const as = { ...req.user, username: mb.address, email: mb.address, name: mb.name, shared_mailbox: mb.id };
      try { out.push({ id: mb.id, unseen: ((await withFolder(as, 'INBOX', (c) => c.search({ seen: false }, { uid: true }))) || []).length }); }
      catch { out.push({ id: mb.id, unseen: null }); } // not reachable just now
    }
    res.json(out);
  });

  // A shared mailbox (x-mailbox header, or ?mailbox= for links): for members, the mail actions below work
  // on it instead of their own mailbox (reading, moving, flags, folders, drafts and sending as it). Things
  // kept per person (filters, labels, signatures, snoozing, scheduled sending…) stay with their own mail.
  const SHARED_OK = [
    ['GET', /^\/(unread|folders|messages|find)$/], ['GET', /^\/messages\/\d+(\/(conversation|quote|pictures\/\d+|attachments\/\d+(\/preview|\/zip)?))?$/],
    ['POST', /^\/folders$/], ['PATCH', /^\/folders$/], ['DELETE', /^\/folders$/],
    ['POST', /^\/messages\/(flags|read-all|move|delete)$/], ['POST', /^\/messages\/\d+\/attachments\/save$/],
    ['POST', /^\/drafts$/], ['GET', /^\/drafts\/\d+$/], ['DELETE', /^\/drafts\/\d+$/], ['POST', /^\/send$/], ['POST', /^\/assign$/], ['GET', /^\/members$/], ['GET', /^\/notes$/], ['POST', /^\/notes$/], ['DELETE', /^\/notes\/[\w-]+$/],
  ];
  r.use((req, res, next) => {
    const id = req.get('x-mailbox') || (req.method === 'GET' ? req.query.mailbox : null);
    if (!id) return next();
    const mb = String(id).startsWith('d:') ? delegatedMailboxFor(req.user, id) : sharedMailboxFor(req.user, id);
    if (!mb) return next(new HttpError(404, 'Shared mailbox not found'));
    if (!SHARED_OK.some(([m, re]) => m === req.method && re.test(req.path))) return next(bad('That isn’t available in a shared mailbox'));
    if (mb.delegated && /^\/(assign|members|notes)/.test(req.path)) return next(bad('Assigning and internal notes are for shared mailboxes'));
    if (req.path === '/send' && (req.body?.sendAt != null || req.body?.followUp)) return next(bad('Send from a shared mailbox now (scheduling and follow-up reminders are for your own mail)'));
    req.realUserId = req.user.id; req.realUserName = req.user.name;
    // A delegate sends as the owner, and the mail says who actually sent it (Sender:).
    req.user = { ...req.user, username: mb.address, email: mb.address, name: mb.name, shared_mailbox: mb.id, ...(mb.delegated && { delegate: { name: req.realUserName, address: req.user.username } }) };
    next();
  });

  // Delegation (your own mail only): who can read and answer it, and whose mail you can.
  r.get('/delegates', (req, res) => {
    res.json({ mine: delegatesOf(req.user.id), toMe: delegatedMailboxesFor(req.user).map((m) => ({ id: m.id.slice(2), name: m.name, username: m.address })) });
  });
  r.post('/delegates', (req, res) => {
    if (!mailEnabled()) throw bad('Email is not set up on this server');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const d = q('SELECT id, name, username, disabled FROM users WHERE username = ? AND org_id = ?').get(email, req.user.org_id);
    if (!d || d.disabled) throw bad('Choose someone in your company');
    if (d.id === req.user.id) throw bad('That’s you');
    if (delegatesOf(req.user.id).length >= MAX_DELEGATES) throw bad(`At most ${MAX_DELEGATES} people can have your mail`);
    q('INSERT OR IGNORE INTO mail_delegates (owner_id, delegate_id, created_at) VALUES (?, ?, ?)').run(req.user.id, d.id, now());
    audit(req, 'mail.delegate', { target: d.username });
    notifyBell([d.id], { kind: 'share', title: `${req.user.name || req.user.username} gave you access to their mail`, body: 'Pick it under Mailbox in Mail.', link: '/mail', actor: req.user.name });
    res.status(201).json(delegatesOf(req.user.id));
  });
  r.delete('/delegates/:id', (req, res) => {
    const gone = q('DELETE FROM mail_delegates WHERE owner_id = ? AND delegate_id = ?').run(req.user.id, req.params.id).changes;
    if (!gone) throw notFound('Not a delegate');
    audit(req, 'mail.undelegate', { target: q('SELECT username FROM users WHERE id = ?').get(req.params.id)?.username || req.params.id });
    res.json(delegatesOf(req.user.id));
  });

  // In a shared mailbox: its members (to give a message to), and giving a message to one of them
  // ({ message_id, subject, assignee_id: id | null, done }). The person given it is told.
  r.get('/members', (req, res) => {
    if (!req.user.shared_mailbox) throw bad('Only shared mailboxes have members');
    res.json(sharedMembers(req.user.shared_mailbox).map((m) => ({ id: m.id, name: m.name, username: m.username })));
  });
  // Internal notes on a message of a shared mailbox (only its people see them).
  r.get('/notes', (req, res) => {
    const mb = req.user.shared_mailbox;
    const messageId = cleanMessageId(req.query.message_id);
    if (!mb || !messageId) throw bad('Notes are on messages in shared mailboxes');
    res.json(notesOf(mb, messageId));
  });
  r.post('/notes', (req, res) => {
    const mb = req.user.shared_mailbox;
    const messageId = cleanMessageId(req.body?.message_id);
    if (!mb || !messageId) throw bad('Notes are on messages in shared mailboxes');
    const body = str(req.body?.body, { required: true, name: 'Note', max: 4000 });
    if (q('SELECT COUNT(*) AS n FROM shared_notes WHERE mailbox_id = ? AND message_id = ?').get(mb, messageId).n >= 200) throw bad('This message has too many notes');
    q('INSERT INTO shared_notes (id, mailbox_id, message_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), mb, messageId, req.realUserId, body, now());
    sendTo(sharedMembers(mb).map((m) => m.id), { type: 'mail-notes', mailbox: mb, message_id: messageId });
    res.status(201).json(notesOf(mb, messageId));
  });
  r.delete('/notes/:id', (req, res) => {
    const mb = req.user.shared_mailbox;
    const n = mb && q('SELECT * FROM shared_notes WHERE id = ? AND mailbox_id = ?').get(String(req.params.id), mb);
    if (!n) throw notFound('Note not found');
    if (n.user_id !== req.realUserId) throw bad('Only whoever wrote a note can delete it');
    q('DELETE FROM shared_notes WHERE id = ?').run(n.id);
    sendTo(sharedMembers(mb).map((m) => m.id), { type: 'mail-notes', mailbox: mb, message_id: n.message_id });
    res.json(notesOf(mb, n.message_id));
  });
  r.post('/assign', (req, res) => {
    const mb = req.user.shared_mailbox;
    if (!mb) throw bad('Messages are given to people in shared mailboxes');
    const messageId = cleanMessageId(req.body?.message_id);
    if (!messageId) throw bad('This message can’t be given to anyone (it has no Message-ID)');
    const before = q('SELECT * FROM shared_assignments WHERE mailbox_id = ? AND message_id = ?').get(mb, messageId);
    let assignee = before?.assignee_id ?? null;
    if (req.body?.assignee_id !== undefined) {
      assignee = req.body.assignee_id ? String(req.body.assignee_id) : null;
      if (assignee && !sharedMembers(mb).some((m) => m.id === assignee)) throw bad('Give it to someone who uses this mailbox');
    }
    const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : (before?.done ?? 0);
    const subject = str(req.body?.subject ?? before?.subject ?? '', { max: 300 }) || '';
    q(`INSERT INTO shared_assignments (mailbox_id, message_id, assignee_id, done, subject, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mailbox_id, message_id) DO UPDATE SET assignee_id = excluded.assignee_id, done = excluded.done, subject = excluded.subject, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(mb, messageId, assignee, done, subject, req.realUserId, now());
    if (assignee && assignee !== before?.assignee_id && assignee !== req.realUserId) {
      notifyBell([assignee], { kind: 'assign', title: `${req.realUserName} gave you an email in ${req.user.username}`, body: subject || '(no subject)', link: '/mail', actor: req.realUserId });
    }
    const members = sharedMembers(mb);
    const others = members.map((m) => m.id);
    sendTo(others, { type: 'mail-assigned', mailbox: mb, message_id: messageId });
    const a = assignmentsOf(mb, [messageId]).get(messageId);
    res.json({ message_id: messageId, assignee: a?.assignee || null, done: !!a?.done });
  });


  // Unread mail across the folders you get notifications for (badge on the Mail icon, tab title).
  r.get('/unread', async (req, res) => {
    const byFolder = {};
    for (const f of followedFolders(req.user.id)) {
      try { byFolder[f] = await withFolder(req.user, f, async (c) => ((await c.search({ seen: false }, { uid: true })) || []).length); }
      catch (e) { if (e.status !== 404) throw e; } // a followed folder that no longer exists
    }
    res.json({ unseen: Object.values(byFolder).reduce((a, b) => a + b, 0), byFolder });
  });

  // Folders you get new-mail notifications for (the Inbox always; up to 10 more of your own, or the Archive).
  r.get('/notify-folders', (req, res) => res.json({ folders: followedFolders(req.user.id) }));
  r.put('/notify-folders', async (req, res) => {
    const wanted = (Array.isArray(req.body.folders) ? req.body.folders : []).map(String).filter((f) => f.toUpperCase() !== 'INBOX');
    if (wanted.length > MAX_FOLLOWED) throw bad(`You can follow up to ${MAX_FOLLOWED} folders besides the Inbox`);
    const boxes = await withClient(req.user, (c) => c.list());
    for (const f of wanted) {
      const b = boxes.find((x) => x.path === f);
      if (!b) throw bad(`There is no folder called “${f}”`);
      // The Archive can be followed (filters can file mail there); Sent, Drafts, Junk and Trash can't.
      if (b.specialUse && b.specialUse !== '\\Archive') throw bad(`${b.name} can't be followed`);
    }
    res.json({ folders: setFollowed(req.user.id, wanted) });
  });

  // ---- vacation auto-reply ----
  r.get('/vacation', (req, res) => res.json(vacationOf(req.user.id)));

  r.put('/vacation', (req, res) => {
    const b = req.body;
    const date = (v, label) => {
      if (v === undefined || v === null || v === '') return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(`${label} must be a date`);
      return v;
    };
    const start = date(b.start_date, 'First day');
    const end = date(b.end_date, 'Last day');
    if (start && end && end < start) throw bad('The last day is before the first day');
    const subject = str(b.subject, { max: 200, name: 'Subject' }) || 'Out of office';
    const body = typeof b.body === 'string' ? b.body.slice(0, 5000) : '';
    if (b.enabled && !body.trim()) throw bad('Write the message people should receive');
    setVacation(req.user.id, { enabled: !!b.enabled, subject, body, start_date: start, end_date: end });
    res.json(vacationOf(req.user.id));
  });

  // ---- filter rules (run by the mail server at delivery, see mail/sieve.js) ----
  r.get('/rules', (req, res) => {
    const row = q('SELECT rules FROM mail_rules WHERE user_id = ?').get(req.user.id);
    res.json(row ? JSON.parse(row.rules) : []);
  });

  r.put('/rules', (req, res) => {
    const rules = normalizeRules(req.body.rules);
    q(`INSERT INTO mail_rules (user_id, rules, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`)
      .run(req.user.id, JSON.stringify(rules), Date.now());
    scheduleMailConfig();
    res.json(rules);
  });

  // Block a sender: a filter rule, first in the list, that files their mail in Junk (read). Asking
  // again for the same address changes nothing; Filters shows it and can remove it.
  r.post('/block', async (req, res) => {
    const address = String(req.body.address || '').trim().toLowerCase();
    if (!/^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/.test(address)) throw bad('Not an email address');
    if (address === req.user.username.toLowerCase()) throw bad('You can’t block yourself');
    const junk = await specialOf(req.user, '\\Junk').catch(() => null) || 'Junk';
    const row = q('SELECT rules FROM mail_rules WHERE user_id = ?').get(req.user.id);
    const rules = row ? JSON.parse(row.rules) : [];
    const name = `Blocked: ${address}`;
    if (!rules.some((x) => x.name === name)) {
      const next = normalizeRules([{ name, enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: address }], actions: { moveTo: junk, markRead: true, stop: true } }, ...rules]);
      q(`INSERT INTO mail_rules (user_id, rules, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`).run(req.user.id, JSON.stringify(next), Date.now());
      scheduleMailConfig();
    }
    res.json({ ok: true, rule: name, folder: junk });
  });

  // ---- folders: create, rename, delete (built-in folders are protected) ----
  const cleanFolderName = (v) => {
    const name = str(v, { required: true, name: 'Folder name', max: 100 }).replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    if (!name || /[\x00-\x1f*%]/.test(name) || name.toUpperCase() === 'INBOX') throw bad('That folder name is not allowed');
    return name;
  };
  const isProtected = (b) => b.path.toUpperCase() === 'INBOX' || !!b.specialUse;
  const inTree = (p, root) => p === root || p.startsWith(`${root}/`);

  r.post('/folders', async (req, res) => {
    const name = cleanFolderName(req.body.name);
    const exists = (await withClient(req.user, (c) => c.list())).some((b) => b.path.toLowerCase() === name.toLowerCase());
    if (exists) throw bad('A folder with that name already exists');
    await withClient(req.user, async (c) => { await c.mailboxCreate(name); await c.mailboxSubscribe(name).catch(() => {}); });
    res.status(201).json({ path: name });
  });

  // Rename (subfolders move with it); filters that file mail there are updated.
  r.patch('/folders', async (req, res) => {
    const from = String(req.body.path || '');
    const to = cleanFolderName(req.body.newPath);
    const boxes = await withClient(req.user, (c) => c.list());
    const box = boxes.find((b) => b.path === from);
    if (!box) throw notFound('Folder not found');
    if (isProtected(box)) throw bad('Built-in folders cannot be renamed');
    if (to === from) return res.json({ path: to, updatedFilters: 0 });
    if (inTree(to, from)) throw bad('A folder cannot be moved inside itself');
    if (boxes.some((b) => b.path.toLowerCase() === to.toLowerCase())) throw bad('A folder with that name already exists');
    await withClient(req.user, async (c) => {
      // Leave the folder first: renaming the selected mailbox would confuse the pooled connection.
      (await c.getMailboxLock('INBOX')).release();
      await c.mailboxRename(from, to);
      const renamed = (await c.list()).filter((b) => inTree(b.path, to));
      for (const b of renamed) await c.mailboxSubscribe(b.path).catch(() => {});
    });
    setFollowed(req.user.id, followedFolders(req.user.id).map((f) => (inTree(f, from) ? to + f.slice(from.length) : f)));
    const updatedFilters = updateRules(req.user.id, (rule) => {
      const m = rule.actions.moveTo;
      if (!m || !inTree(m, from)) return false;
      rule.actions.moveTo = to + m.slice(from.length);
      return true;
    });
    res.json({ path: to, updatedFilters });
  });

  // Delete: messages (including subfolders') go to Trash first; filters that filed mail there are switched off.
  r.delete('/folders', async (req, res) => {
    const target = String(req.query.path || '');
    const boxes = await withClient(req.user, (c) => c.list());
    const box = boxes.find((b) => b.path === target);
    if (!box) throw notFound('Folder not found');
    if (isProtected(box)) throw bad('Built-in folders cannot be deleted');
    const trash = boxes.find((b) => b.specialUse === '\\Trash')?.path;
    const victims = boxes.filter((b) => inTree(b.path, target)).sort((a, b) => b.path.length - a.path.length);
    let moved = 0, deleted = 0;
    for (const v of victims) {
      // A parent that only exists as part of a path ("Clients" of "Clients/Acme") holds no mail
      // and disappears by itself once its subfolders are gone.
      const placeholder = v.flags?.has('\\Noselect') || v.flags?.has('\\NonExistent');
      if (placeholder) continue;
      if (trash) {
        moved += await withFolder(req.user, v.path, async (c) => {
          const n = c.mailbox.exists;
          if (n) await c.messageMove('1:*', trash);
          return n;
        });
      }
      await withClient(req.user, async (c) => {
        (await c.getMailboxLock('INBOX')).release();
        await c.mailboxUnsubscribe(v.path).catch(() => {});
        await c.mailboxDelete(v.path);
      });
      deleted++;
    }
    setFollowed(req.user.id, followedFolders(req.user.id).filter((f) => !inTree(f, target)));
    const disabledFilters = updateRules(req.user.id, (rule) => {
      if (!rule.enabled || !rule.actions.moveTo || !inTree(rule.actions.moveTo, target)) return false;
      rule.enabled = false;
      return true;
    });
    res.json({ ok: true, movedToTrash: moved, deletedFolders: deleted, disabledFilters });
  });

  /** Apply fn to each of a user's rules; save and rebuild the Sieve script if any changed. */
  function updateRules(userId, fn) {
    const row = q('SELECT rules FROM mail_rules WHERE user_id = ?').get(userId);
    if (!row) return 0;
    const rules = JSON.parse(row.rules);
    const changed = rules.filter((rule) => fn(rule)).length;
    if (changed) {
      q('UPDATE mail_rules SET rules = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(rules), Date.now(), userId);
      scheduleMailConfig();
    }
    return changed;
  }

  // ---- labels ----
  r.get('/labels', (req, res) => res.json({ labels: labelsOf(req.user.id).map(({ keyword, ...l }) => l), colors: LABEL_COLORS }));

  const labelBody = (b, current = {}) => {
    const name = str(b.name ?? current.name, { required: true, name: 'Label name', max: 40 });
    const color = b.color ?? current.color ?? LABEL_COLORS[0];
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw bad('Pick a colour');
    return { name, color };
  };
  r.post('/labels', (req, res) => {
    const { name, color } = labelBody(req.body || {});
    if (labelsOf(req.user.id).length >= MAX_LABELS) throw bad('Too many labels');
    if (labelsOf(req.user.id).some((l) => l.name.toLowerCase() === name.toLowerCase())) throw bad('You already have a label with that name');
    const id = newId();
    q('INSERT INTO mail_labels (id, user_id, name, color, keyword, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user.id, name, color, `nwl_${id.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`, now());
    res.status(201).json({ id, name, color });
  });
  r.patch('/labels/:id', (req, res) => {
    const l = q('SELECT * FROM mail_labels WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!l) throw notFound('Label not found');
    const { name, color } = labelBody(req.body || {}, l);
    if (labelsOf(req.user.id).some((x) => x.id !== l.id && x.name.toLowerCase() === name.toLowerCase())) throw bad('You already have a label with that name');
    q('UPDATE mail_labels SET name = ?, color = ? WHERE id = ?').run(name, color, l.id);
    res.json({ id: l.id, name, color });
  });
  // Deleting a label takes it off every message, in every folder.
  r.delete('/labels/:id', async (req, res) => {
    const l = q('SELECT * FROM mail_labels WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!l) throw notFound('Label not found');
    const boxes = await withClient(req.user, (c) => c.list());
    let n = 0;
    for (const b of boxes.filter((x) => !x.flags?.has('\\Noselect'))) {
      await withFolder(req.user, b.path, async (c) => {
        const uids = (await c.search({ keyword: l.keyword }, { uid: true })) || [];
        if (uids.length) { await c.messageFlagsRemove(uids.join(','), [l.keyword], { uid: true }); n += uids.length; }
      }).catch(() => {});
    }
    q('DELETE FROM mail_labels WHERE id = ?').run(l.id);
    res.json({ ok: true, messages: n });
  });
  // Put labels on messages, or take them off: { folder, uids, add: [labelId], remove: [labelId] }.
  r.post('/messages/labels', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    const mine = new Map(labelsOf(req.user.id).map((l) => [l.id, l.keyword]));
    const kw = (list) => (Array.isArray(list) ? list : []).map((id) => { if (!mine.has(id)) throw bad('Unknown label'); return mine.get(id); });
    const add = kw(req.body.add), remove = kw(req.body.remove);
    await withFolder(req.user, folder, async (c) => {
      if (add.length) await c.messageFlagsAdd(uids, add, { uid: true });
      if (remove.length) await c.messageFlagsRemove(uids, remove, { uid: true });
    });
    res.json({ ok: true });
  });

  // ---- templates: saved messages (subject and body) to start a message or a reply from ----
  r.get('/templates', (req, res) => res.json(q('SELECT id, name, subject, html, updated_at FROM mail_templates WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id)));
  const readTemplate = (b, cur = {}) => {
    const name = str(b.name ?? cur.name, { required: true, name: 'Template name', max: 100 });
    const subject = str(b.subject ?? cur.subject ?? '', { max: 300, name: 'Subject' }) || '';
    const html = typeof (b.html ?? cur.html) === 'string' ? (b.html ?? cur.html) : '';
    if (html.length > 100000) throw bad('The template is too long');
    return { name, subject, html };
  };
  r.post('/templates', (req, res) => {
    const t = readTemplate(req.body || {});
    if (q('SELECT COUNT(*) AS n FROM mail_templates WHERE user_id = ?').get(req.user.id).n >= 200) throw bad('Too many templates');
    if (q('SELECT 1 FROM mail_templates WHERE user_id = ? AND name = ? COLLATE NOCASE').get(req.user.id, t.name)) throw bad('You already have a template with that name');
    const id = newId();
    q('INSERT INTO mail_templates (id, user_id, name, subject, html, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.user.id, t.name, t.subject, t.html, now());
    res.status(201).json({ id, ...t });
  });
  r.patch('/templates/:id', (req, res) => {
    const cur = q('SELECT * FROM mail_templates WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!cur) throw notFound('Template not found');
    const t = readTemplate(req.body || {}, cur);
    if (q('SELECT 1 FROM mail_templates WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(req.user.id, t.name, cur.id)) throw bad('You already have a template with that name');
    q('UPDATE mail_templates SET name = ?, subject = ?, html = ?, updated_at = ? WHERE id = ?').run(t.name, t.subject, t.html, now(), cur.id);
    res.json({ id: cur.id, ...t });
  });
  r.delete('/templates/:id', (req, res) => {
    if (!q('DELETE FROM mail_templates WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id).changes) throw notFound('Template not found');
    res.json({ ok: true });
  });

  // ---- signatures: one per sending address ----
  r.get('/signatures', (req, res) => {
    const company_mode = companySignature(req.user.org_id).mode; // off | default | always
    res.json(identities(req.user).map((i) => ({ address: i.address, company_mode, ...signatureOf(req.user.id, i.address, req.user) })));
  });
  r.put('/signatures/:address', (req, res) => {
    const address = String(req.params.address).toLowerCase();
    if (!identities(req.user).some((i) => i.address === address)) throw bad('You cannot send from that address');
    if (companySignature(req.user.org_id).mode === 'always') throw bad('Your company uses one signature for everyone; an admin changes it in Admin → Company settings');
    const html = typeof req.body.html === 'string' ? req.body.html : '';
    if (html.length > 20000) throw bad('The signature is too long');
    q(`INSERT INTO identity_signatures (user_id, address, html, on_new, on_reply, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, address) DO UPDATE SET html = excluded.html, on_new = excluded.on_new, on_reply = excluded.on_reply, updated_at = excluded.updated_at`)
      .run(req.user.id, address, html, req.body.on_new === false ? 0 : 1, req.body.on_reply === false ? 0 : 1, Date.now());
    res.json({ address, ...signatureOf(req.user.id, address, req.user) });
  });
  // Back to the company's signature (when it's the default): forget your own.
  r.delete('/signatures/:address', (req, res) => {
    q('DELETE FROM identity_signatures WHERE user_id = ? AND address = ?').run(req.user.id, String(req.params.address).toLowerCase());
    res.json({ address: String(req.params.address).toLowerCase(), ...signatureOf(req.user.id, String(req.params.address).toLowerCase(), req.user) });
  });

  // Saved searches: a search (with the folder it's in) kept in the sidebar, with how many unread match.
  r.get('/searches', async (req, res) => {
    const list = q('SELECT id, name, folder, query FROM mail_searches WHERE user_id = ? ORDER BY position, created_at').all(req.user.id);
    for (const sv of list) {
      try {
        const parsed = parseMailQuery(sv.query);
        sv.unseen = parsed.query ? ((await withFolder(req.user, sv.folder, (c) => c.search(allOf([parsed.query, { seen: false }]), { uid: true }))) || []).length : 0;
      } catch { sv.unseen = null; } // a folder that's gone
    }
    res.json(list);
  });
  r.post('/searches', (req, res) => {
    const query = String(req.body?.query || '').trim().slice(0, 500);
    const folder = String(req.body?.folder || 'INBOX').slice(0, 300);
    if (!query) throw bad('Search for something first');
    const parsed = parseMailQuery(query);
    if (parsed.error) throw bad(parsed.error);
    const name = String(req.body?.name || query).trim().slice(0, 60) || query.slice(0, 60);
    if (q('SELECT COUNT(*) AS n FROM mail_searches WHERE user_id = ?').get(req.user.id).n >= 30) throw bad('At most 30 saved searches');
    if (q('SELECT 1 FROM mail_searches WHERE user_id = ? AND folder = ? AND query = ?').get(req.user.id, folder, query)) throw bad('That search is saved already');
    const id = newId();
    q('INSERT INTO mail_searches (id, user_id, name, folder, query, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.user.id, name, folder, query, Date.now(), Date.now());
    res.status(201).json({ id, name, folder, query });
  });
  r.patch('/searches/:id', (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) throw bad('Give it a name');
    if (!q('UPDATE mail_searches SET name = ? WHERE id = ? AND user_id = ?').run(name, String(req.params.id), req.user.id).changes) throw notFound('Saved search not found');
    res.json({ ok: true });
  });
  r.delete('/searches/:id', (req, res) => {
    if (!q('DELETE FROM mail_searches WHERE id = ? AND user_id = ?').run(String(req.params.id), req.user.id).changes) throw notFound('Saved search not found');
    res.json({ ok: true });
  });

  r.get('/folders', async (req, res) => {
    const boxes = await withClient(req.user, (c) => c.list({ statusQuery: { messages: true, unseen: true } }));
    const rank = (b) => (b.specialUse ? ORDER.indexOf(b.specialUse) : b.path === 'INBOX' ? 0 : 99);
    res.json(boxes.filter((b) => !b.flags?.has('\\Noselect'))
      // Nested folders show their full path ("Partners / Globex") so it's clear where they live.
      .map((b) => ({ path: b.path, name: b.path === 'INBOX' ? 'Inbox' : b.path.split(b.delimiter || '/').join(' / '), specialUse: b.path === 'INBOX' ? '\\Inbox' : b.specialUse || null,
        messages: b.status?.messages ?? 0, unseen: b.status?.unseen ?? 0 }))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
  });

  r.get('/messages', async (req, res) => {
    const folder = String(req.query.folder || 'INBOX');
    const page = Math.max(1, Number(req.query.page) || 1);
    const term = String(req.query.q || '').trim();
    const labels = labelsOf(req.user.id);
    const byKeyword = new Map(labels.map((l) => [l.keyword.toLowerCase(), l.id]));
    const only = req.query.label ? labels.find((l) => l.id === req.query.label) : null;
    if (req.query.label && !only) throw notFound('Label not found');
    const parsed = parseMailQuery(term);
    if (parsed.error) throw bad(parsed.error);
    // Inbox tabs (Primary, Updates): only for the Inbox itself, not while searching.
    const tab = folder === 'INBOX' && !term && !only && TABS.includes(req.query.tab) && inboxTabsOn(req.user.id) ? req.query.tab : null;
    const out = await withFolder(req.user, folder, async (client) => {
      const total = client.mailbox.exists;
      let range, uidMode = false, count = total;
      // How many unread are in the other tab, for its badge.
      const otherUnread = tab ? ((await client.search(allOf([tabQuery(tab === 'primary' ? 'updates' : 'primary'), { seen: false }]), { uid: true })) || []).length : undefined;
      if (parsed.query || only || tab) {
        const query = allOf([...(parsed.query ? [parsed.query] : []), ...(only ? [{ keyword: only.keyword }] : []), ...(tab ? [tabQuery(tab)] : [])]);
        const uids = (await client.search(query, { uid: true })) || [];
        uids.sort((a, b) => b - a);
        count = uids.length;
        const slice = uids.slice((page - 1) * PAGE, page * PAGE);
        if (!slice.length) return { total: count, page, messages: [], ...(tab && { tab, otherUnread }) };
        range = slice.join(',');
        uidMode = true;
      } else {
        const end = total - (page - 1) * PAGE;
        if (end < 1) return { total, page, messages: [] };
        range = `${Math.max(1, end - PAGE + 1)}:${end}`;
      }
      const messages = [];
      for await (const m of client.fetch(range, { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, size: true }, { uid: uidMode })) {
        const env = m.envelope || {};
        messages.push({
          uid: m.uid,
          subject: env.subject || '',
          from: addr(env.from?.[0]),
          to: (env.to || []).map(addr),
          date: (env.date || m.internalDate)?.valueOf?.() ?? null,
          seen: m.flags.has('\\Seen'),
          flagged: m.flags.has('\\Flagged'),
          answered: m.flags.has('\\Answered'),
          labels: [...m.flags].map((f) => byKeyword.get(String(f).toLowerCase())).filter(Boolean),
          attachment: hasAttachment(m.bodyStructure),
          size: m.size,
          messageId: env.messageId || null,
        });
      }
      messages.sort((a, b) => b.uid - a.uid);
      if (folder === SNOOZED) {
        const until = new Map(q('SELECT uid, until FROM snoozed_mail WHERE user_id = ?').all(req.user.id).map((x) => [x.uid, x.until]));
        for (const m of messages) m.snoozedUntil = until.get(m.uid) ?? null;
      }
      return { total: count, page, pageSize: PAGE, messages, ...(tab && { tab, otherUnread }) };
    });
    // A shared mailbox: who each message is given to, and whether it's done.
    if (req.user.shared_mailbox && out.messages?.length) {
      const by = assignmentsOf(req.user.shared_mailbox, out.messages.map((m) => m.messageId));
      const notes = noteCounts(req.user.shared_mailbox, out.messages.map((m) => m.messageId));
      for (const m of out.messages) { const a = by.get(m.messageId); m.assignee = a?.assignee || null; m.done = !!a?.done; m.notes = notes.get(m.messageId) || 0; }
    }
    res.json(out);
  });

  async function loadMessage(user, folder, uid, markSeen, parseOptions = {}) {
    return withFolder(user, folder, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!msg) throw notFound('Message not found');
      if (markSeen && !msg.flags.has('\\Seen')) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      return { parsed: await simpleParser(msg.source, parseOptions), flags: msg.flags };
    });
  }

  // Was a message I sent delivered? From the mail server's log, by its Message-ID (only mail sent from
  // one of my own addresses). { available, recipients: [{ to, reached?, status, response, at, tries }] | null }.
  r.get('/delivery', (req, res) => {
    const text = readMaillog();
    if (text === null) return res.json({ available: false, recipients: null });
    res.json({ available: true, recipients: deliveryOf(parseMaillog(text), String(req.query.message_id || '').slice(0, 300), identities(req.user).map((i) => i.address)) });
  });

  r.get('/messages/:uid', async (req, res) => {
    const folder = String(req.query.folder || 'INBOX');
    const { parsed: p, flags } = await loadMessage(req.user, folder, Number(req.params.uid), true);
    res.json({
      uid: Number(req.params.uid), folder,
      subject: p.subject || '', date: p.date?.valueOf() ?? null,
      from: addrList(p.from)[0] || null, to: addrList(p.to), cc: addrList(p.cc), replyTo: addrList(p.replyTo),
      // Sent by someone else for the sender (a delegate): the Sender: header, when it differs from From.
      sentBy: (() => { const sn = addrList(p.headers?.get('sender'))[0]; const fr = addrList(p.from)[0]; return sn && sn.address && sn.address !== fr?.address ? sn : null; })(),
      messageId: p.messageId || null, references: [].concat(p.references || []),
      html: p.html || null, text: p.text || '', textAsHtml: p.textAsHtml || '',
      flagged: flags.has('\\Flagged'),
      labels: (() => { const kw = new Map(labelsOf(req.user.id).map((l) => [l.keyword.toLowerCase(), l.id])); return [...flags].map((f) => kw.get(String(f).toLowerCase())).filter(Boolean); })(),
      spam: /yes/i.test(String(p.headers.get('x-spam') || '')),
      attachments: attachmentList(p),
      invite: inviteFor(req.user, p),
      // The sender asked for a read receipt (and it hasn't been answered yet): offered, never sent by itself.
      receipt: (() => {
        if (flags.has('$MDNSent')) return null;
        const to = receiptRequest(p, identities(req.user).map((i) => i.address));
        return to ? { to } : null;
      })(),
      // A mailing list's way out: done here (one click, or an email), or a page to open.
      unsubscribe: (() => {
        const u = unsubscribeOptions(p.headerLines);
        if (!u) return null;
        return u.oneClick ? { how: 'one-click' } : u.mailto ? { how: 'email', to: u.mailto.to } : { how: 'link', url: u.url };
      })(),
      // In a shared mailbox: who it's given to, and whether it's done.
      ...(req.user.shared_mailbox && (() => { const x = p.messageId && assignmentsOf(req.user.shared_mailbox, [p.messageId]).get(p.messageId); return { assignee: x?.assignee || null, done: !!x?.done }; })()),
    });
  });

  // Answer an invitation from another calendar: Yes / Maybe / No (puts it on your calendar, or takes it
  // off, and emails the organizer the answer), or take a cancelled one off your calendar.
  r.post('/messages/:uid/invite', async (req, res) => {
    const folder = String(req.body?.folder || 'INBOX');
    const answer = String(req.body?.answer || '');
    if (!['yes', 'maybe', 'no', 'remove'].includes(answer)) throw bad('Answer yes, maybe or no');
    const { parsed: p } = await loadMessage(req.user, folder, Number(req.params.uid), false);
    const text = calendarPartOf(p);
    const mine = identities(req.user).map((i) => i.address);
    const inv = readInvite(text, mine, req.user.tz || 'UTC');
    if (!inv || inviteFor(req.user, p)?.internal) throw bad('There is no invitation to answer in this message');
    if (inv.method === 'CANCEL' ? answer !== 'remove' : !['REQUEST', 'PUBLISH'].includes(inv.method) || answer === 'remove') throw bad('This invitation can’t be answered that way');
    const id = saveInvite(req.user.id, inv, answer);
    eventsChanged([req.user.id]);
    let replied = false;
    if (inv.method === 'REQUEST' && inv.organizer?.email && !mine.includes(inv.organizer.email)) {
      const me = { name: req.user.name, email: inv.mine?.email || req.user.username };
      const word = { yes: 'Accepted', maybe: 'Tentative', no: 'Declined' }[answer];
      try {
        await smtpFor(req.user).sendMail({ from: { name: req.user.name, address: me.email }, to: inv.organizer.email, subject: `${word}: ${inv.event.title}`,
          text: `${req.user.name} has ${{ yes: 'accepted', maybe: 'tentatively accepted', no: 'declined' }[answer]} this invitation: ${inv.event.title}`,
          icalEvent: { method: 'REPLY', filename: 'reply.ics', content: replyIcs(text, me, answer) } });
        replied = true;
      } catch (e) { console.error('[mail] invitation reply:', e.message); }
    }
    res.json({ ...inviteFor(req.user, p), replied, event_id: id });
  });

  // Answer a read-receipt request: send the receipt, or not; either way it isn't asked again ($MDNSent).
  r.post('/messages/:uid/receipt', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uid = Number(req.params.uid);
    const { parsed: p, flags } = await loadMessage(req.user, folder, uid, false);
    if (flags.has('$MDNSent')) return res.json({ sent: false, already: true });
    const to = receiptRequest(p, identities(req.user).map((i) => i.address));
    if (!to) throw bad('This message didn’t ask for a read receipt');
    if (req.body.send) {
      const raw = buildReceipt(p, { from: { name: req.user.name, address: req.user.username }, to, host: MAIL_HOSTNAME || 'localhost' });
      try { await smtpFor(req.user).sendMail({ envelope: { from: req.user.username, to: [to] }, raw }); }
      catch (e) { throw new HttpError(e.responseCode && e.responseCode < 500 ? 503 : 400, `Sending the receipt failed: ${e.response || e.message}`); }
    }
    await withFolder(req.user, folder, (c) => c.messageFlagsAdd(String(uid), ['$MDNSent'], { uid: true }));
    res.json({ sent: !!req.body.send });
  });

  // The rest of a message's conversation: messages with the same subject (without Re:/Fwd:) that share
  // someone with it, in the Inbox, Sent, Archive and the message's own folder, oldest first.
  // Where a message is now, by its Message-ID (a task made from it links here, and the message may
  // have been archived or moved since). The Inbox and Archive are looked in first.
  r.get('/find', async (req, res) => {
    const id = String(req.query.message_id || '').trim();
    if (!id || id.length > 1000 || /[\r\n]/.test(id)) throw bad('Message ID needed');
    const boxes = (await withClient(req.user, (c) => c.list())).filter((b) => !b.flags?.has?.('\\Noselect'));
    const rank = (b) => (b.path === 'INBOX' ? 0 : b.specialUse === '\\Archive' ? 1 : b.specialUse === '\\Trash' ? 3 : 2);
    for (const b of boxes.sort((x, y) => rank(x) - rank(y))) {
      const uids = await withFolder(req.user, b.path, (c) => c.search({ header: { 'message-id': id } }, { uid: true })).catch(() => []);
      if (uids?.length) return res.json({ folder: b.path, uid: Math.max(...uids) });
    }
    throw notFound('That email is no longer in your mailbox');
  });

  r.get('/messages/:uid/conversation', async (req, res) => {
    const folder = String(req.query.folder || 'INBOX');
    const uid = Number(req.params.uid);
    const me = await withFolder(req.user, folder, async (client) => (await client.fetchOne(String(uid), { envelope: true }, { uid: true }))?.envelope);
    if (!me) throw notFound('Message not found');
    const base = baseSubject(me.subject);
    if (!base) return res.json([]);
    const self = { from: addr(me.from?.[0]), to: (me.to || []).map(addr), cc: (me.cc || []).map(addr) };
    const folders = [...new Set(['INBOX', folder, ...(await withClient(req.user, async (c) => Promise.all(['\\Sent', '\\Archive'].map((u) => specialFolder(c, u)))))].filter(Boolean))];
    const out = [];
    for (const f of folders) {
      await withFolder(req.user, f, async (client) => {
        // The server finds candidates by a word of the subject; the exact comparison is ours.
        const word = base.split(' ').sort((x, y) => y.length - x.length)[0];
        const uids = ((await client.search({ subject: word }, { uid: true })) || []).sort((x, y) => y - x).slice(0, 200);
        if (!uids.length) return;
        for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
          if (f === folder && m.uid === uid) continue;
          const env = m.envelope || {};
          const it = { folder: f, uid: m.uid, subject: env.subject || '', from: addr(env.from?.[0]), to: (env.to || []).map(addr), cc: (env.cc || []).map(addr),
            date: (env.date || m.internalDate)?.valueOf?.() ?? null, seen: m.flags.has('\\Seen'), messageId: env.messageId || null };
          if (baseSubject(it.subject) === base && shareSomeone(self, it)) out.push(it);
        }
      }).catch(() => {}); // a folder that isn't there is skipped
    }
    // The same message in two folders (sent to yourself) counts once.
    const seen = new Set();
    const list = out.filter((m) => !m.messageId || !seen.has(m.messageId) && seen.add(m.messageId)).sort((a, b) => (a.date || 0) - (b.date || 0)).slice(-50);
    res.json(list.map(({ cc, messageId, ...m }) => m));
  });

  // Recent mail with someone (from them, or to or copied to them): Inbox, Sent and Archive, newest
  // first, at most 10. For a contact's or a colleague's card.
  r.get('/with', async (req, res) => {
    const a = String(req.query.address || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw bad('Give an email address');
    const folders = [...new Set(['INBOX', ...(await withClient(req.user, async (c) => Promise.all(['\\Sent', '\\Archive'].map((u) => specialFolder(c, u)))))].filter(Boolean))];
    const out = [];
    for (const f of folders) {
      await withFolder(req.user, f, async (client) => {
        const uids = ((await client.search({ or: [{ from: a }, { to: a }, { cc: a }] }, { uid: true })) || []).sort((x, y) => y - x).slice(0, 10);
        if (!uids.length) return;
        for await (const m of client.fetch(uids.join(','), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const env = m.envelope || {};
          out.push({ folder: f, uid: m.uid, subject: env.subject || '', from: addr(env.from?.[0]), date: (env.date || m.internalDate)?.valueOf?.() ?? null,
            seen: m.flags.has('\\Seen'), sent: f !== 'INBOX' && addr(env.from?.[0])?.address?.toLowerCase() !== a, messageId: env.messageId || null });
        }
      }).catch(() => {}); // a folder that isn't there is skipped
    }
    const seen = new Set();
    res.json(out.filter((m) => !m.messageId || !seen.has(m.messageId) && seen.add(m.messageId)).sort((x, y) => (y.date || 0) - (x.date || 0)).slice(0, 10).map(({ messageId, ...m }) => m));
  });

  // Importing mail from another account: start one, and how the latest is going.
  r.post('/import', async (req, res) => res.status(201).json(await startImport(req.user, req.body || {})));
  r.get('/import', (req, res) => res.json(importOf(req.user.id)));
  r.post('/import-mbox', async (req, res) => res.status(201).json(await startMboxImport(req.user, req.body || {})));

  // Manage subscriptions: the newsletters and lists in your Inbox (last 180 days), by sender.
  r.get('/subscriptions', async (req, res) => {
    const since = new Date(Date.now() - 180 * 864e5);
    const list = await withFolder(req.user, 'INBOX', async (c) => {
      const uids = ((await c.search({ since, header: { 'list-unsubscribe': true } }, { uid: true })) || []).slice(-3000);
      if (!uids.length) return [];
      const out = [];
      for await (const m of c.fetch(uids, { uid: true, envelope: true, headers: ['list-unsubscribe', 'list-unsubscribe-post'] }, { uid: true })) {
        out.push({ uid: m.uid, from: m.envelope?.from?.[0], date: m.envelope?.date, headers: m.headers?.toString() || '' });
      }
      return out;
    });
    res.json(groupSubscriptions(list));
  });

  // Unsubscribe from the list a message came from: a one-click request to the list's web address,
  // or else an email to its unsubscribe address, sent from you.
  r.post('/messages/:uid/unsubscribe', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const { parsed: p } = await loadMessage(req.user, folder, Number(req.params.uid), false);
    const u = unsubscribeOptions(p.headerLines);
    if (!u || (!u.oneClick && !u.mailto)) throw bad('This message has no way to unsubscribe from here');
    const list = addrList(p.from)[0]?.address || 'the list';
    if (u.oneClick) {
      try {
        const status = await oneClickUnsubscribe(u.url);
        if (status >= 200 && status < 400) return res.json({ ok: true, how: 'one-click', list });
        if (!u.mailto) throw new HttpError(424, `The list answered with an error (${status}). Try again later.`);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (!u.mailto) throw new HttpError(424, `Couldn’t unsubscribe: ${e.message}`);
      }
    }
    await smtpFor(req.user).sendMail({ from: { name: req.user.name, address: req.user.username }, to: u.mailto.to, subject: u.mailto.subject, text: u.mailto.body });
    res.json({ ok: true, how: 'email', to: u.mailto.to, list });
  });

  // The original's body for quoting in a reply or forward: its text with basic formatting and the
  // pictures embedded in it, cleaned on the server (see forwardhtml.js). null for plain-text mail.
  r.get('/messages/:uid/quote', async (req, res) => {
    const folder = String(req.query.folder || 'INBOX');
    const uid = Number(req.params.uid);
    const { parsed: p } = await loadMessage(req.user, folder, uid, false, { keepCidLinks: true });
    if (!p.html) return res.json({ html: null, pictures: 0 });
    const byCid = new Map(p.attachments.map((a, i) => [String(a.contentId || '').replace(/^<|>$/g, '').toLowerCase(), { a, i }]));
    const out = forwardHtml(p.html, (cid) => {
      const hit = byCid.get(String(cid).toLowerCase());
      if (!hit || !PICTURE_TYPES.test(hit.a.contentType || '')) return null;
      return forwardPictureUrl(folder, uid, hit.i) + (req.user.shared_mailbox ? `&mailbox=${encodeURIComponent(req.user.shared_mailbox)}` : '');
    });
    res.json(out);
  });

  // A picture embedded in a received message, shown while writing a reply or forward. Only the
  // picture types mail apps display (never SVG), with nothing else allowed to load.
  // "Show original": the message's headers and what they say (checks, servers, times), and the whole message as an .eml file.
  const rawMessage = (req) => withFolder(req.user, String(req.query.folder || 'INBOX'), async (client) => {
    const msg = await client.fetchOne(String(Number(req.params.uid)), { source: true, envelope: true }, { uid: true });
    if (!msg?.source) throw notFound('Message not found');
    return msg;
  });
  r.get('/messages/:uid/original', async (req, res) => {
    const msg = await rawMessage(req);
    res.json({ ...originalSummary(msg.source), size: msg.source.length });
  });
  r.get('/messages/:uid/eml', async (req, res) => {
    const msg = await rawMessage(req);
    const name = `${String(msg.envelope?.subject || 'message').replace(/[\\/:*?"<>|\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'message'}.eml`;
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="message.eml"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(msg.source);
  });

  r.get('/messages/:uid/pictures/:n', async (req, res) => {
    const { parsed } = await loadMessage(req.user, String(req.query.folder || 'INBOX'), Number(req.params.uid), false);
    const a = parsed.attachments[Number(req.params.n)];
    if (!a || !PICTURE_TYPES.test(a.contentType || '')) throw notFound('Picture not found');
    res.setHeader('Content-Type', a.contentType.toLowerCase());
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(a.content);
  });

  r.get('/messages/:uid/attachments/:index', async (req, res) => {
    const { parsed } = await loadMessage(req.user, String(req.query.folder || 'INBOX'), Number(req.params.uid), false);
    const a = parsed.attachments.filter((x) => !x.related)[Number(req.params.index)];
    if (!a) throw notFound('Attachment not found');
    // ?view shows the safe kinds (pictures, PDF, text, audio, video) in the browser; anything else downloads.
    const shown = req.query.view !== undefined && previewMime(a.filename);
    if (shown) { res.set(previewHeaders(shown, a.filename)); res.end(a.content); return; }
    // Otherwise always download (never render attacker-supplied content on our origin).
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename || 'attachment')}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(a.content);
  });

  // A Word, Excel or PowerPoint attachment as a read-only document, spreadsheet or presentation.
  r.get('/messages/:uid/attachments/:index/preview', async (req, res) => {
    const { parsed } = await loadMessage(req.user, String(req.query.folder || 'INBOX'), Number(req.params.uid), false);
    const a = parsed.attachments.filter((x) => !x.related)[Number(req.params.index)];
    if (!a) throw notFound('Attachment not found');
    res.json(await officePreview(a.content, a.filename, req.realUserId || req.user.id));
  });

  // What's inside a zip attachment.
  r.get('/messages/:uid/attachments/:index/zip', async (req, res) => {
    const { parsed } = await loadMessage(req.user, String(req.query.folder || 'INBOX'), Number(req.params.uid), false);
    const a = parsed.attachments.filter((x) => !x.related)[Number(req.params.index)];
    if (!a) throw notFound('Attachment not found');
    if (!/\.zip$/i.test(a.filename || '')) throw bad('Not a zip file');
    res.json(await zipEntries(a.content));
  });

  // Save attachments to Drive, in an "Email attachments" folder (made when first needed): all of them, or the ones asked.
  r.post('/messages/:uid/attachments/save', async (req, res) => {
    const { parsed } = await loadMessage(req.user, String(req.body.folder || 'INBOX'), Number(req.params.uid), false);
    const all = parsed.attachments.filter((x) => !x.related);
    const wanted = Array.isArray(req.body.indexes) ? [...new Set(req.body.indexes.map(Number))] : all.map((_, i) => i);
    const picked = wanted.map((i) => all[i]);
    if (!picked.length || picked.some((a) => !a)) throw notFound('Attachment not found');
    checkQuota(req.user.org_id, picked.reduce((n, a) => n + a.content.length, 0), req.user.id);
    let folderId = q("SELECT id FROM files WHERE owner_id = ? AND parent_id IS NULL AND kind = 'folder' AND name = 'Email attachments' AND trashed = 0").get(req.user.id)?.id;
    if (!folderId) folderId = insertFile({ owner: req.user.id, parentId: null, name: 'Email attachments', kind: 'folder' });
    const saved = [];
    for (const a of picked) {
      const storage = newId();
      fs.writeFileSync(path.join(FILES_DIR, storage), a.content);
      const name = cleanName(String(a.filename || '').replace(/[/\\\0]/g, '_').trim().slice(0, 255).replace(/^\.{1,2}$/, '') || 'attachment');
      const id = insertFile({ owner: req.user.id, parentId: folderId, name, kind: 'file', mime: mimeFor(name), size: a.content.length, storage });
      saved.push(q('SELECT id, name, size, mime FROM files WHERE id = ?').get(id));
    }
    sendTo([req.user.id], { type: 'files-changed', parent_id: folderId });
    res.status(201).json({ folder_id: folderId, files: saved });
  });

  r.post('/messages/flags', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    await withFolder(req.user, folder, async (client) => {
      for (const [key, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged']]) {
        if (req.body[key] === true) await client.messageFlagsAdd(uids, [flag], { uid: true });
        if (req.body[key] === false) await client.messageFlagsRemove(uids, [flag], { uid: true });
      }
    });
    res.json({ ok: true });
  });

  // Mark everything in a folder as read. Returns how many were unread.
  r.post('/messages/read-all', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const n = await withFolder(req.user, folder, async (client) => {
      const unread = await client.search({ seen: false }, { uid: true });
      if (unread.length) await client.messageFlagsAdd(unread, ['\\Seen'], { uid: true });
      return unread.length;
    });
    res.json({ ok: true, marked: n });
  });

  // Inbox tabs: on unless turned off (Settings → Mail); a message moved to the other tab by hand.
  r.get('/inbox-tabs', (req, res) => res.json({ on: inboxTabsOn(req.user.id) }));
  r.put('/inbox-tabs', (req, res) => {
    q('UPDATE users SET inbox_tabs = ? WHERE id = ?').run(req.body?.on ? 1 : 0, req.user.id);
    res.json({ on: !!req.body?.on });
  });
  r.post('/messages/:uid/tab', async (req, res) => {
    const tab = req.body?.tab;
    if (!TABS.includes(tab)) throw bad('Primary or Updates');
    const uid = String(Number(req.params.uid));
    await withFolder(req.user, 'INBOX', async (c) => {
      await c.messageFlagsRemove(uid, [TO_PRIMARY, TO_UPDATES], { uid: true });
      await c.messageFlagsAdd(uid, [tab === 'primary' ? TO_PRIMARY : TO_UPDATES], { uid: true });
    });
    res.json({ ok: true, tab });
  });

  if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'plus_folders')) q('ALTER TABLE users ADD COLUMN plus_folders INTEGER NOT NULL DEFAULT 0').run();
  // Plus addresses into folders: { on } (see mail/sieve.js). Mail to you+name@… goes into your folder "name".
  r.get('/plus-folders', (req, res) => res.json({ on: !!q('SELECT plus_folders FROM users WHERE id = ?').get(req.user.id)?.plus_folders, example: req.user.username.replace('@', '+receipts@') }));
  r.put('/plus-folders', (req, res) => {
    q('UPDATE users SET plus_folders = ? WHERE id = ?').run(req.body?.on ? 1 : 0, req.user.id);
    scheduleMailConfig();
    res.json({ on: !!req.body?.on, example: req.user.username.replace('@', '+receipts@') });
  });

  // Muted conversations: { message_id, references, subject } of a message in it. From then on, replies
  // in that conversation go straight to Archive, already read (a Sieve rule, so phones and mail apps
  // see the same). One entry per conversation; muting again adds the newest messages' ids to it.
  const MAX_MUTED = 200;
  const mutedOf = (userId) => q('SELECT id, subject, ids, created_at FROM mail_muted WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    .map((m) => ({ ...m, ids: JSON.parse(m.ids) }));
  r.get('/muted', (req, res) => res.json(mutedOf(req.user.id).map(({ ids, ...m }) => ({ ...m, message_ids: ids }))));
  r.post('/muted', (req, res) => {
    const ids = [...new Set([req.body?.message_id, ...[].concat(req.body?.references || [])].map(cleanMessageId).filter(Boolean))].slice(-50);
    if (!ids.length) throw bad('This message can’t be muted (it has no Message-ID)');
    const mine = mutedOf(req.user.id);
    const same = mine.find((m) => m.ids.some((x) => ids.includes(x)));
    const subject = str(req.body?.subject ?? '', { max: 300 }) || '';
    if (same) q('UPDATE mail_muted SET ids = ? WHERE id = ?').run(JSON.stringify([...new Set([...same.ids, ...ids])].slice(-100)), same.id);
    else {
      if (mine.length >= MAX_MUTED) throw bad(`You can mute up to ${MAX_MUTED} conversations; unmute some first`);
      q('INSERT INTO mail_muted (id, user_id, subject, ids, created_at) VALUES (?, ?, ?, ?, ?)').run(newId(), req.user.id, subject, JSON.stringify(ids), now());
    }
    scheduleMailConfig();
    res.status(same ? 200 : 201).json({ muted: true, id: same?.id || q('SELECT id FROM mail_muted WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id).id });
  });
  // Is a message's conversation muted? (?message_id=&references=a,b)
  r.get('/muted/check', (req, res) => {
    const ids = [req.query.message_id, ...String(req.query.references || '').split(/[\s,]+/)].map(cleanMessageId).filter(Boolean);
    const m = ids.length && mutedOf(req.user.id).find((x) => x.ids.some((y) => ids.includes(y)));
    res.json({ muted: !!m, id: m ? m.id : null });
  });
  r.delete('/muted/:id', (req, res) => {
    const gone = q('DELETE FROM mail_muted WHERE id = ? AND user_id = ?').run(String(req.params.id), req.user.id).changes;
    if (!gone) throw notFound();
    scheduleMailConfig();
    res.json({ muted: false });
  });

  // Move to another folder; `to` may be a path or a special folder: inbox, archive, junk, trash.
  r.post('/messages/move', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    const special = { inbox: 'INBOX', archive: '\\Archive', junk: '\\Junk', trash: '\\Trash' }[req.body.to];
    const target = special === 'INBOX' ? 'INBOX' : special ? await specialOf(req.user, special) : str(req.body.to, { required: true, name: 'to' });
    if (!target) throw bad('Target folder not found');
    if (target === folder) return res.json({ ok: true });
    await withFolder(req.user, folder, (c) => c.messageMove(uids, target, { uid: true }));
    forgetSnoozes(req.user, folder, uids);
    res.json({ ok: true });
  });

  // Snooze until a time: into the Snoozed folder (made if needed), back to the Inbox when due.
  // Snoozing what's already snoozed changes when it comes back.
  r.post('/messages/snooze', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids);
    const until = Number(req.body.until);
    if (!Number.isFinite(until) || until < Date.now() + 30e3) throw bad('Choose a time in the future');
    if (until > Date.now() + MAX_SNOOZE_MS) throw bad('Snooze for at most a year');
    if (folder === SNOOZED) {
      for (const u of uids) q('UPDATE snoozed_mail SET until = ? WHERE user_id = ? AND uid = ?').run(until, req.user.id, u);
      return res.json({ ok: true, snoozed: uids.length });
    }
    await withClient(req.user, async (c) => { if (!(await c.list()).some((b) => b.path === SNOOZED)) await c.mailboxCreate(SNOOZED).catch(() => {}); });
    const moved = await withFolder(req.user, folder, async (c) => {
      const info = new Map();
      for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true }, { uid: true })) info.set(m.uid, m.envelope || {});
      const result = await c.messageMove(uids.join(','), SNOOZED, { uid: true });
      return [...info].map(([uid, env]) => ({ uid: result?.uidMap?.get(uid), env })).filter((x) => x.uid);
    });
    for (const m of moved) {
      q('INSERT INTO snoozed_mail (id, user_id, uid, message_id, subject, until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(newId(), req.user.id, m.uid, m.env.messageId || null, m.env.subject || '', until, now());
    }
    res.json({ ok: true, snoozed: moved.length });
  });

  // Unsnooze: back to the Inbox now.
  r.post('/messages/unsnooze', async (req, res) => {
    const uids = uidList(req.body.uids);
    const rows = q(`SELECT * FROM snoozed_mail WHERE user_id = ? AND uid IN (${uids.map(() => '?').join(',')})`).all(req.user.id, ...uids);
    // Messages put in Snoozed some other way have no row: move them back too.
    const loose = uids.filter((u) => !rows.some((r) => r.uid === u)).map((u) => ({ id: `loose-${u}`, uid: u, message_id: null }));
    await wake(req.user, [...rows, ...loose]);
    res.json({ ok: true });
  });

  // Delete: move to Trash, or delete permanently when already in Trash (or Junk).
  r.post('/messages/delete', async (req, res) => {
    const folder = String(req.body.folder || 'INBOX');
    const uids = uidList(req.body.uids).join(',');
    const trash = await specialOf(req.user, '\\Trash');
    const junk = await specialOf(req.user, '\\Junk');
    if (!trash || folder === trash || folder === junk) keepIfHeld(req.user.id, 'Mail');
    if (!trash || folder === trash || folder === junk) await withFolder(req.user, folder, (c) => c.messageDelete(uids, { uid: true }));
    else await withFolder(req.user, folder, (c) => c.messageMove(uids, trash, { uid: true }));
    forgetSnoozes(req.user, folder, uids);
    res.json({ ok: true });
  });

  // ---- drafts (stored in the IMAP Drafts folder, so phones and Outlook see them too) ----
  r.post('/drafts', async (req, res) => {
    const b = req.body;
    const folder = await specialOf(req.user, '\\Drafts');
    if (!folder) throw bad('No Drafts folder');
    const from = identities(req.user).find((i) => i.address === String(b.from || '').toLowerCase()) || identities(req.user)[0];
    const meta = {
      from: from.address, to: String(b.to || ''), cc: String(b.cc || ''), bcc: String(b.bcc || ''),
      attachments: (Array.isArray(b.attachments) ? b.attachments : []).map(String).slice(0, 50),
      inReplyTo: b.inReplyTo ? String(b.inReplyTo) : null, references: [].concat(b.references || []).map(String).slice(-20),
      replyTo: b.replyTo?.folder && b.replyTo?.uid ? { folder: String(b.replyTo.folder), uid: Number(b.replyTo.uid) } : null,
      forwardOf: b.forwardOf?.folder && b.forwardOf?.uid ? {
        folder: String(b.forwardOf.folder), uid: Number(b.forwardOf.uid),
        attachments: (Array.isArray(b.forwardOf.attachments) ? b.forwardOf.attachments : []).map(Number).slice(0, 50),
        asEml: !!b.forwardOf.asEml,
        eml: b.forwardOf.eml ? { filename: String(b.forwardOf.eml.filename || '').slice(0, 255), size: Number(b.forwardOf.eml.size) || 0 } : null,
        files: (Array.isArray(b.forwardOf.files) ? b.forwardOf.files : []).slice(0, 50).map((x) => ({ index: Number(x.index), filename: String(x.filename || '').slice(0, 255), size: Number(x.size) || 0 })),
      } : null,
    };
    // Half-typed addresses are fine in a draft: keep exactly what was typed in our own header.
    const lenient = (v) => addressparser(v, { flatten: true }).filter((a) => EMAIL_RE.test(a.address || '')).map((a) => ({ name: a.name || '', address: a.address }));
    const raw = await new MailComposer({
      from: { name: from.name, address: from.address },
      to: lenient(meta.to), cc: lenient(meta.cc),
      subject: String(b.subject || '').slice(0, 998),
      text: typeof b.text === 'string' ? b.text : '',
      ...(typeof b.html === 'string' && b.html && { html: b.html.slice(0, 2_000_000) }),
      ...(meta.inReplyTo && { inReplyTo: meta.inReplyTo, references: meta.references }),
      headers: { 'X-Workspace-Draft': chunk(Buffer.from(JSON.stringify(meta)).toString('base64')) },
    }).compile().build();
    const appended = await withClient(req.user, (c) => c.append(folder, raw, ['\\Draft', '\\Seen']));
    if (b.uid) await deleteDraft(req.user, folder, Number(b.uid));
    res.json({ uid: appended?.uid ?? null, savedAt: Date.now() });
  });

  r.get('/drafts/:uid', async (req, res) => {
    const folder = await specialOf(req.user, '\\Drafts');
    const { parsed: p } = await loadMessage(req.user, folder, Number(req.params.uid), false);
    let meta = null;
    try {
      const h = p.headers.get('x-workspace-draft');
      const joined = [].concat(h || []).map(String).sort().map((x) => x.replace(/^\d+:/, '')).join('');
      if (joined) meta = JSON.parse(Buffer.from(joined, 'base64').toString('utf8'));
    } catch { meta = null; }
    const fmt = (list) => addrList(list).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
    const files = (meta?.attachments || []).map((id) => q("SELECT id, name, size, kind, no_download FROM files WHERE id = ?").get(id))
      .filter((f) => f && f.kind === 'file' && roleFor(f.id, req.user.id) && mayTakeAway(f, roleFor(f.id, req.user.id)));
    res.json({
      uid: Number(req.params.uid),
      from: meta?.from || addrList(p.from)[0]?.address || req.user.username,
      to: meta?.to ?? fmt(p.to), cc: meta?.cc ?? fmt(p.cc), bcc: meta?.bcc ?? fmt(p.bcc),
      subject: p.subject || '', text: p.text || '', html: p.html || null,
      attachments: files,
      inReplyTo: meta?.inReplyTo || p.inReplyTo || null, references: meta?.references || [].concat(p.references || []),
      replyTo: meta?.replyTo || null,
      forwardOf: meta?.forwardOf || null,
    });
  });

  r.delete('/drafts/:uid', async (req, res) => {
    const folder = await specialOf(req.user, '\\Drafts');
    await deleteDraft(req.user, folder, Number(req.params.uid));
    res.json({ ok: true });
  });

  async function deleteDraft(user, folder, uid) {
    if (!folder || !Number.isInteger(uid) || uid < 1) return;
    await withFolder(user, folder, async (c) => {
      const m = await c.fetchOne(String(uid), { flags: true }, { uid: true });
      if (m && m.flags.has('\\Draft')) await c.messageDelete(String(uid), { uid: true });
    });
  }

  /** Check and build a message from what the compose window sends: { raw, envelope, all, subject }. */
  async function buildMessage(req) {
    const b = req.body;
    const to = parseRecipients(b.to, 'To');
    const cc = parseRecipients(b.cc, 'Cc');
    const bcc = parseRecipients(b.bcc, 'Bcc');
    const all = [...to, ...cc, ...bcc];
    if (!all.length) throw bad('Add at least one recipient');
    if (all.length > 100) throw bad('At most 100 recipients per message');
    const from = identities(req.user).find((i) => i.address === String(b.from || req.user.username).toLowerCase());
    if (!from) throw bad('You cannot send from that address');

    // Large files as links: your own files, sent as a download link (a public link that lasts 30 days)
    // instead of attached, so a message can carry more than 25 MB. Listed at the end of the message.
    const asLinks = new Set(Array.isArray(b.linkAttachments) ? b.linkAttachments.map(String) : []);
    const linked = [];
    if (asLinks.size) {
      if (!q('SELECT allow_links FROM orgs WHERE id = ?').get(req.user.org_id)?.allow_links) throw bad('Your company has turned off public links, so files can’t be sent as links');
      for (const id of asLinks) {
        const f = q("SELECT id, name, size, kind, trashed FROM files WHERE id = ?").get(id);
        if (!f || f.kind !== 'file' || f.trashed || !roleFor(f.id, req.user.id)) throw bad('An attachment is not available');
        if (roleFor(f.id, req.user.id) !== 'owner') throw bad(`“${f.name}” isn’t yours, so it can’t be sent as a link: attach it instead`);
        linked.push(f);
      }
    }
    // Attachments: files from Drive the sender can open.
    let total = 0;
    const attachments = [];
    for (const id of (Array.isArray(b.attachments) ? b.attachments : []).filter((x) => !asLinks.has(String(x)))) {
      const f = q("SELECT id, name, mime, size, storage, kind, no_download FROM files WHERE id = ?").get(id);
      if (!f || f.kind !== 'file' || !roleFor(f.id, req.user.id)) throw bad('An attachment is not available');
      if (!mayTakeAway(f, roleFor(f.id, req.user.id))) throw bad(`“${f.name}” can’t be sent: its owner has turned off downloading and copying for people who can only view it`);
      total += f.size;
      attachments.push({ filename: f.name, contentType: f.mime || 'application/octet-stream', path: path.join(FILES_DIR, f.storage) });
    }
    // Forward as attachment: the original message, exactly as received, attached as an .eml file.
    if (b.forwardOf?.folder && b.forwardOf?.uid && b.forwardOf.asEml) {
      const source = await withFolder(req.user, String(b.forwardOf.folder), async (c) => (await c.fetchOne(String(Number(b.forwardOf.uid)), { source: true, envelope: true }, { uid: true })) || null)
        .catch(() => null);
      if (!source?.source) throw bad('The original message is no longer there, so it can’t be attached');
      total += source.source.length;
      const name = (source.envelope?.subject || 'message').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'message';
      // Explicitly an attachment: Nodemailer marks message/rfc822 "inline" by default, which makes
      // mail apps unpack it into the body instead of showing an .eml file.
      attachments.push({ filename: `${name}.eml`, content: source.source, contentType: 'message/rfc822', contentDisposition: 'attachment' });
    }
    // Forwarding: attachments chosen from the original message are attached straight from the mailbox.
    if (b.forwardOf?.folder && b.forwardOf?.uid && Array.isArray(b.forwardOf.attachments) && b.forwardOf.attachments.length) {
      let original;
      try { original = (await loadMessage(req.user, String(b.forwardOf.folder), Number(b.forwardOf.uid), false)).parsed; }
      catch { throw bad('The original message is no longer there, so its attachments can’t be included'); }
      const listed = original.attachments.filter((a) => !a.related);
      for (const i of new Set(b.forwardOf.attachments.map(Number))) {
        const a = listed[i];
        if (!a) throw bad('An attachment of the original message is missing');
        total += a.size;
        attachments.push({ filename: a.filename || `attachment-${i + 1}`, content: a.content, contentType: a.contentType || 'application/octet-stream' });
      }
    }
    // Inline images: <img src="/api/files/<id>/raw"> (pictures inserted from Drive or pasted) are
    // embedded in the message as cid: parts, so recipients see them without access to this server.
    let html = typeof b.html === 'string' && b.html ? b.html : null;
    if (html) {
      const embedded = new Map();
      html = html.replace(/(<img\b[^>]*?\bsrc=")\/api\/files\/([0-9a-f-]{36})\/raw(?:\?[^"]*)?(")/gi, (m, pre, id, post) => {
        if (!embedded.has(id)) {
          const f = q("SELECT id, name, mime, size, storage, kind, no_download FROM files WHERE id = ?").get(id);
          if (!f || f.kind !== 'file' || !roleFor(f.id, req.user.id)) throw bad('A picture in the message is not available');
          if (!/^image\/(png|jpeg|gif|webp)$/.test(f.mime || '')) throw bad(`“${f.name}” is not a picture that can be shown in email`);
          total += f.size;
          embedded.set(id, { filename: f.name, contentType: f.mime, path: path.join(FILES_DIR, f.storage), cid: `img-${id}@workspace`, contentDisposition: 'inline' });
        }
        return `${pre}cid:img-${id}@workspace${post}`;
      });
      attachments.push(...embedded.values());
      // Pictures quoted from a message you reply to or forward are embedded straight from the original.
      const originals = new Map();
      const pics = new Map();
      for (const [, , uid, n, folder] of html.matchAll(FORWARD_PICTURE_RE)) {
        const key = `${uid}/${n}/${folder}`;
        if (pics.has(key)) continue;
        const f = decodeURIComponent(folder);
        if (!originals.has(`${f}/${uid}`)) {
          const msg = await loadMessage(req.user, f, Number(uid), false).catch(() => null);
          if (!msg) throw bad('The original message is no longer there, so its pictures can’t be included');
          originals.set(`${f}/${uid}`, msg.parsed);
        }
        const a = originals.get(`${f}/${uid}`).attachments[Number(n)];
        if (!a || !PICTURE_TYPES.test(a.contentType || '')) throw bad('A picture from the original message is missing');
        total += a.size;
        pics.set(key, { filename: a.filename || `picture-${Number(n) + 1}`, contentType: a.contentType, content: a.content, cid: `fwd-${uid}-${n}-${pics.size}@workspace`, contentDisposition: 'inline' });
      }
      if (pics.size) {
        html = html.replace(FORWARD_PICTURE_RE, (m, pre, uid, n, folder) => `${pre}cid:${pics.get(`${uid}/${n}/${folder}`).cid}"`);
        attachments.push(...pics.values());
      }
    }
    if (total > MAX_SEND_BYTES) throw bad('Attachments and pictures are larger than 25 MB in total: send the large files as links');

    // The links, made now that the message is going (so a failed check above leaves none behind).
    let text = typeof b.text === 'string' ? b.text : '';
    if (linked.length) {
      const until = Date.now() + LINK_DAYS * 864e5;
      const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const items = linked.map((f) => {
        const token = crypto.randomBytes(18).toString('base64url');
        q(`INSERT INTO share_links (id, token, file_id, created_by, created_at, expires_at, mode) VALUES (?, ?, ?, ?, ?, ?, 'view')`).run(newId(), token, f.id, req.user.id, Date.now(), until);
        return { name: f.name, size: f.size, url: `${base}/s/${token}` };
      });
      audit(req, 'link.create', { target: items.map((i) => i.name).join(', ').slice(0, 300), details: { by_email: true, expires: until } });
      const day = new Date(until).toISOString().slice(0, 10);
      const sizeOf = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
      const escHtml = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      text += `\n\nFiles (download links, until ${day}):\n${items.map((i) => `- ${i.name} (${sizeOf(i.size)}): ${i.url}`).join('\n')}\n`;
      if (html) html += `<div style="margin-top:16px;padding:12px;border:1px solid #dadce0;border-radius:8px"><div style="font-size:13px;color:#5f6368">Files (download links, until ${day})</div>${items.map((i) => `<div style="margin-top:6px">📎 <a href="${escHtml(i.url)}">${escHtml(i.name)}</a> <span style="color:#5f6368">(${sizeOf(i.size)})</span></div>`).join('')}</div>`;
    }

    const mail = {
      from: { name: from.name, address: from.address },
      to, cc, bcc,
      subject: str(b.subject, { max: 998, name: 'Subject' }) || '',
      text,
      ...(html && { html }),
      ...(b.inReplyTo && { inReplyTo: String(b.inReplyTo), references: [].concat(b.references || [], b.inReplyTo).map(String).slice(-20) }),
      ...(b.receipt && { headers: { 'Disposition-Notification-To': from.address } }), // ask for a read receipt
      ...(req.user.delegate && { sender: { name: req.user.delegate.name, address: req.user.delegate.address } }), // sent by a delegate
      attachments,
    };
    const raw = await new MailComposer(mail).compile().build();
    const envelope = { from: from.address, to: all.map((a) => a.address) };
    return { raw, envelope, all, subject: mail.subject, to: [...to, ...cc].map((a) => a.name || a.address) };
  }

  r.post('/send', async (req, res) => {
    const b = req.body;
    const recipients = ['to', 'cc', 'bcc'].flatMap((k) => { try { return parseRecipients(b[k], k).map((a) => a.address); } catch { return []; } });
    if (dataRulesStop(req, res, { recipients, subject: b.subject, text: b.text, html: b.html, confirmed: b.dlpConfirmed === true })) return;
    if (b.confidential && b.sendAt != null) throw bad('Confidential messages are sent straight away');
    // Later: the message is built now (attachments as they are now) and sent when it's due.
    if (b.sendAt !== undefined && b.sendAt !== null) {
      const at = Number(b.sendAt);
      if (!Number.isFinite(at) || at < Date.now() + 30e3) throw bad('Choose a time in the future');
      if (at > Date.now() + 366 * 864e5) throw bad('Messages can be scheduled up to a year ahead');
      if (q("SELECT COUNT(*) AS n FROM scheduled_mail WHERE user_id = ? AND status != 'sent'").get(req.user.id).n >= MAX_SCHEDULED) throw bad(`At most ${MAX_SCHEDULED} messages can wait to be sent`);
      const m = await buildMessage(req);
      const id = newId();
      fs.mkdirSync(OUTBOX, { recursive: true });
      fs.writeFileSync(path.join(OUTBOX, `${id}.eml`), m.raw);
      q(`INSERT INTO scheduled_mail (id, user_id, send_at, envelope, subject, recipients, reply_to, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`).run(id, req.user.id, at, JSON.stringify(m.envelope), m.subject, JSON.stringify(m.to),
        b.replyTo?.folder && b.replyTo?.uid ? JSON.stringify({ folder: String(b.replyTo.folder), uid: Number(b.replyTo.uid) }) : null, now());
      if (b.draftUid) await deleteDraft(req.user, await specialOf(req.user, '\\Drafts').catch(() => null), Number(b.draftUid)).catch(() => {});
      recordSent(req.user, m.all);
      if (b.followUp) addFollowUp(req.user, m.raw, m, b.followUp, at);
      sendTo([req.user.id], { type: 'mail-scheduled' });
      return res.status(201).json({ ok: true, scheduled: { id, send_at: at } });
    }
    if (b.followUp && !FOLLOW_UP_DAYS.includes(Number(b.followUp))) throw bad('Choose when to be reminded');
    // Confidential: the message stays here; the email carries a link to it, readable until it expires.
    if (b.confidential) {
      const days = Number(b.confidential.days);
      if (!EXPIRY_DAYS.includes(days)) throw bad('Choose how long it can be read');
      if ((b.attachments || []).length || (b.linkAttachments || []).length || b.forwardOf?.asEml) throw bad('Confidential messages can’t carry attachments: share the files from Drive instead');
      const token = newToken(), expiresAt = Date.now() + days * 864e5;
      const notice = noticeOf({ fromName: req.user.name, subject: b.subject || '', link: `${publicBase(req)}/c/${token}`, expiresAt });
      const cm = await buildMessage({ user: req.user, body: { ...b, text: notice.text, html: notice.html, attachments: [], linkAttachments: [], forwardOf: null } });
      keepConfidential({ token, user: req.user, from: { name: req.user.name, address: String(b.from || req.user.username).toLowerCase() }, subject: b.subject || '', html: b.html || null, text: b.text || null, recipients: cm.all, days });
      await deliver(req.user, cm.raw, cm.envelope, { replyTo: b.replyTo });
      recordSent(req.user, cm.all);
      if (b.draftUid) await deleteDraft(req.user, await specialOf(req.user, '\\Drafts').catch(() => null), Number(b.draftUid)).catch(() => {});
      return res.json({ ok: true, recipients: cm.all.length, confidential: { token, expires_at: expiresAt } });
    }
    const m = await buildMessage(req);
    await deliver(req.user, m.raw, m.envelope, { replyTo: b.replyTo });
    recordSent(req.user, m.all);
    if (b.followUp) addFollowUp(req.user, m.raw, m, b.followUp);
    if (b.draftUid) await deleteDraft(req.user, await specialOf(req.user, '\\Drafts').catch(() => null), Number(b.draftUid)).catch(() => {});
    res.json({ ok: true, recipients: m.all.length });
  });

  // Mail merge: { from, subject, text, columns: [names], rows: [{ email, fields: { Column: value } }], test }.
  // Each row gets its own message (only their address on it), with {{Column}} filled in from the row.
  // test: true sends just the first row's message, to yourself. Returns { sent, failed: [{ email, error }] }.
  r.post('/merge', async (req, res) => {
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) throw bad('There is nobody to send to');
    if (rows.length > MAX_MERGE) throw bad(`Mail merge sends up to ${MAX_MERGE} messages at a time`);
    const subject = str(b.subject, { max: 998, name: 'Subject' }) || '';
    const text = String(b.text || '');
    if (!subject.trim() && !text.trim()) throw bad('Write a subject or a message');
    if (text.length > 100000) throw bad('The message is too long');
    const unknown = unknownPlaceholders(subject, text, Array.isArray(b.columns) ? b.columns.map(String) : []);
    if (unknown.length) throw bad(`No column called ${unknown.map((u) => `“${u}”`).join(', ')}`);
    const list = b.test ? [{ email: req.user.username, fields: rows[0].fields }] : rows;
    // The rules look at the message as written and at the values filled into it.
    const filled = rows.slice(0, MAX_MERGE).map((r) => Object.values(r?.fields || {}).join(' ')).join('\n');
    if (dataRulesStop(req, res, { recipients: list.map((r) => String(r?.email || '').toLowerCase()), subject, text: `${text}\n${filled}`, confirmed: b.dlpConfirmed === true })) return;
    const sent = [], failed = [];
    for (const row of list) {
      const email = String(row?.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { failed.push({ email: email || '(empty)', error: 'Not an email address' }); continue; }
      try {
        const fields = row.fields && typeof row.fields === 'object' ? row.fields : {};
        const m = await buildMessage({ user: req.user, body: { from: b.from, to: email, subject: fillTemplate(subject, fields).replace(/[\r\n]+/g, ' '), text: fillTemplate(text, fields), html: mergeHtml(text, fields) } });
        await deliver(req.user, m.raw, m.envelope);
        if (!b.test) recordSent(req.user, m.all);
        sent.push(email);
      } catch (e) { failed.push({ email, error: e.message }); }
    }
    if (!b.test) audit(req, 'mail.merge', { target: subject.slice(0, 200), details: { sent: sent.length, failed: failed.length } });
    res.json({ sent: sent.length, failed });
  });

  // Follow-up reminders: ?message_id= for one message's, or all that are waiting; DELETE cancels one.
  r.get('/followups', (req, res) => {
    const rows = req.query.message_id ? q('SELECT id, message_id, subject, recipients, due_at FROM mail_followups WHERE user_id = ? AND message_id = ?').all(req.user.id, String(req.query.message_id))
      : q('SELECT id, message_id, subject, recipients, due_at FROM mail_followups WHERE user_id = ? ORDER BY due_at').all(req.user.id);
    res.json(rows.map((r) => ({ ...r, recipients: JSON.parse(r.recipients || '[]') })));
  });
  r.delete('/followups/:id', (req, res) => {
    const row = q('SELECT id FROM mail_followups WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row) throw notFound();
    q('DELETE FROM mail_followups WHERE id = ?').run(row.id);
    sendTo([req.user.id], { type: 'mail-followups' });
    res.json({ ok: true });
  });

  // Messages waiting to be sent.
  r.get('/scheduled', (req, res) => {
    res.json(q("SELECT id, send_at, subject, recipients, status, error FROM scheduled_mail WHERE user_id = ? ORDER BY send_at").all(req.user.id)
      .map((s) => ({ ...s, recipients: JSON.parse(s.recipients || '[]') })));
  });
  // Send it now instead (a failed one is tried again).
  r.post('/scheduled/:id/send', async (req, res) => {
    const row = q('SELECT id FROM scheduled_mail WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row) throw notFound('That message is no longer waiting (it may have been sent)');
    q("UPDATE scheduled_mail SET send_at = ?, status = 'scheduled', tries = 0, error = NULL WHERE id = ?").run(Date.now() - 1, row.id);
    await sendDue();
    const left = q('SELECT status, error FROM scheduled_mail WHERE id = ?').get(row.id);
    if (left?.status === 'failed' || left?.error) throw new HttpError(503, left.error || 'Sending failed');
    res.json({ ok: true });
  });
  // Don't send it after all: it goes back to Drafts, to change or send another time.
  r.delete('/scheduled/:id', async (req, res) => {
    const row = q('SELECT * FROM scheduled_mail WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row) throw notFound('That message is no longer waiting (it may have been sent)');
    q('DELETE FROM scheduled_mail WHERE id = ?').run(row.id); // first, so the sender can't pick it up meanwhile
    const file = path.join(OUTBOX, `${row.id}.eml`);
    const drafts = await specialOf(req.user, '\\Drafts').catch(() => null);
    let back = false;
    if (drafts && fs.existsSync(file)) back = await withClient(req.user, (c) => c.append(drafts, fs.readFileSync(file), ['\\Draft', '\\Seen'])).then(() => true).catch(() => false);
    fs.rm(file, { force: true }, () => {});
    sendTo([req.user.id], { type: 'mail-scheduled' });
    res.json({ ok: true, draft: back });
  });

  return r;
}

const PICTURE_TYPES = /^image\/(png|jpeg|gif|webp)$/i;
const forwardPictureUrl = (folder, uid, n) => `/api/mail/messages/${uid}/pictures/${n}?folder=${encodeURIComponent(folder)}`;
const FORWARD_PICTURE_RE = /(<img\b[^>]*?\bsrc=")\/api\/mail\/messages\/(\d+)\/pictures\/(\d+)\?folder=([^"&]+)(?:&(?:amp;)?mailbox=[^"&]+)?"/gi; // (a shared mailbox's pictures carry &mailbox=)

/** Split a long header value into numbered pieces (RFC 5322 lines must stay under 998 characters). */
function chunk(value, size = 800) {
  const out = [];
  for (let i = 0; i * size < value.length; i++) out.push(`${String(i).padStart(3, '0')}:${value.slice(i * size, (i + 1) * size)}`);
  return out.length ? out : ['000:'];
}

/** Attachments a reader sees (pictures embedded in the HTML are not listed). Indexes are used for download and forwarding. */
/**
 * An invitation (or a cancellation) in the message, as Mail shows it: what, when, who's organising,
 * and whether it's on your calendar with your answer. One of this server's own invitations points
 * to Calendar instead (it's answered there).
 */
function inviteFor(user, p) {
  const text = calendarPartOf(p);
  if (!text) return null;
  // A guest's answer to one of your invitations: recorded on the event (once), and shown as such.
  const reply = readReply(text);
  if (reply) { const r = recordReply(user.id, reply); return r ? { method: 'REPLY', ...r } : null; }
  const mine = identities(user).map((i) => i.address);
  const inv = readInvite(text, mine, user.tz || 'UTC');
  if (!inv || !['REQUEST', 'CANCEL', 'PUBLISH'].includes(inv.method)) return null;
  if (inv.organizer?.email && mine.includes(inv.organizer.email)) return null; // your own invitation
  const ours = new RegExp(`^(.+)@${String(MAIL_HOSTNAME || 'workspace').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).exec(inv.uid || '');
  const local = ours && q('SELECT e.id FROM events e JOIN event_guests g ON g.event_id = e.id AND g.user_id = ? WHERE e.id = ?').get(user.id, ours[1]);
  const e = inv.event;
  const base = { method: inv.method, title: e.title, start: e.start, end: e.end, all_day: !!e.all_day, location: e.location, repeats: !!e.rrule, organizer: inv.organizer };
  if (local) return { ...base, internal: true, event_id: local.id };
  const have = eventForInvite(user.id, inv.uid);
  return { ...base, event_id: have?.id || null, answer: have?.ext_status || null };
}

function attachmentList(p) {
  return p.attachments.filter((a) => !a.related)
    .map((a, i) => ({ index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, size: a.size }));
}

/** The signature for one of your addresses: your own, or the company's (company: 'default' | 'always'). */
function signatureOf(userId, address, user = null) {
  const mode = user ? companySignature(user.org_id).mode : 'off';
  if (mode === 'always') return { html: companySignatureFor(user, address), on_new: true, on_reply: true, company: 'always' };
  const sg = q('SELECT html, on_new, on_reply FROM identity_signatures WHERE user_id = ? AND address = ?').get(userId, address);
  if (sg) return { html: sg.html, on_new: !!sg.on_new, on_reply: !!sg.on_reply };
  if (mode === 'default') return { html: companySignatureFor(user, address), on_new: true, on_reply: true, company: 'default' };
  return { html: '', on_new: true, on_reply: true };
}

function vacationOf(userId) {
  const v = q('SELECT enabled, subject, body, start_date, end_date FROM vacations WHERE user_id = ?').get(userId);
  const today = new Date().toISOString().slice(0, 10);
  const out = v ? { ...v, enabled: !!v.enabled } : { enabled: false, subject: 'Out of office', body: '', start_date: null, end_date: null };
  // "active" = replying right now; "scheduled" = on, but the first day is still ahead.
  out.active = out.enabled && (!out.end_date || out.end_date >= today) && (!out.start_date || out.start_date <= today);
  out.scheduled = out.enabled && !!out.start_date && out.start_date > today;
  return out;
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}
