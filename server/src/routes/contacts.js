import { Router } from 'express';
import { binAndDelete, restoreFromBin } from '../recyclebin.js';
import { expand } from '../calserver.js';
import { outEvent } from './calendar.js';
import { q, tx, fold } from '../db.js';
import express from 'express';
import { uid, now, str, notFound, bad } from '../util.js';
import { contactsFromFile, contactsToCsv, contactsToVcf, MAX_IMPORT, contactsTable } from '../contactfiles.js';
import { sheetFromRows } from '../office/tablesheet.js';
import { insertFile, sheetAsCsv } from './files.js';
import { canReach, orgMemberIds } from '../tenancy.js';
import { sendTo } from '../hub.js';
import { notify } from '../notifications.js';
import { birthdayOf, birthdaysBetween } from '../birthday.js';
import { duplicateGroups, mergedFields } from '../contactmerge.js';
import { otherContactsOf, matchOther, forgetOther } from '../othercontacts.js';
import { trashContact, trashOf, restoreContact, purgeTrash, sweepContactTrash, TRASH_DAYS } from '../contacttrash.js';
import { photoOf, setPhoto, withPhoto, photoFromCard, MAX_PHOTO } from '../contactphotos.js';
import { cleanMore, withMore, liftCardMore } from '../contactmore.js';
import { cleanDates, cleanCustom, datesBetween } from '../contactfields.js';
import { buildVcard } from '../vcard.js';
import { REMIND } from '../contactreminders.js';
import { zoneOrUtc } from '../ics.js';
import { watchContacts, undoContacts, changedSince, sweepContactHistory, HISTORY_DAYS } from '../contacthistory.js';
import { frequentOf, forgetSent, sentTimes } from '../mail/includes.js';

// Keep in touch: how often (days) you mean to be in touch with someone, and when you last were (sending them
// email counts, or Mark as contacted).
for (const [col, type] of [['touch_days', 'INTEGER'], ['last_contact', 'INTEGER']]) if (!q('PRAGMA table_info(contacts)').all().some((c) => c.name === col)) q(`ALTER TABLE contacts ADD COLUMN ${col} ${type}`).run();
export const TOUCH_DAYS = [7, 14, 30, 60, 90, 180, 365];
// A log of your calls and meetings with a contact ("Called about the renewal"): yours, newest first.
q(`CREATE TABLE IF NOT EXISTS contact_log (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- call | meeting | note
  text TEXT NOT NULL,
  at INTEGER NOT NULL
)`).run();
export const LOG_KINDS = ['call', 'meeting', 'note'];
// How each person sorts their contacts (starred ones first either way).
export const CONTACT_SORTS = ['first', 'last', 'company', 'added', 'touch'];
q(`CREATE TABLE IF NOT EXISTS contact_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sort TEXT NOT NULL DEFAULT 'first'
)`).run();
/** When you're due to be in touch again (ms), or null for no reminder. Never in touch: due now. */
export const touchDue = (c) => (c.touch_days ? (c.last_contact || 0) + c.touch_days * 864e5 : null);
if (!q('PRAGMA table_info(contacts)').all().some((c) => c.name === 'touch_notified')) q('ALTER TABLE contacts ADD COLUMN touch_notified INTEGER').run();
/**
 * A bell notification, once, when someone you've been in touch with before is due again: one for each
 * person with any newly due ("Time to catch up with Rita Moreno", "… and 2 others"). Returns how many sent.
 */
/**
 * A meeting with a contact counts as being in touch: for events of yours that ended in the last `within` ms (each
 * time a repeating one happened, too; not those the contact said No to), your contacts invited to them by email address were in touch when it
 * ended. Runs with the keep-in-touch check (hourly), so a meeting counts within the hour.
 */
export function meetingsCountAsTouch(at = Date.now(), within = 2 * 864e5, ownerId = null) {
  const pairs = new Map(); // owner \u0000 email -> when they last met
  const met = (owner, email, ended) => { const k = `${owner}\u0000${email}`; if (!(pairs.get(k) >= ended)) pairs.set(k, ended); };
  // One-off events that ended in the window.
  for (const m of q(`SELECT e.owner_id, LOWER(g.email) AS email, MAX(e.end) AS ended FROM events e JOIN event_outside_guests g ON g.event_id = e.id
                     WHERE e.rrule IS NULL AND e.end <= ? AND e.end > ? AND g.status != 'no' AND (? IS NULL OR e.owner_id = ?) GROUP BY e.owner_id, LOWER(g.email)`).all(at, at - within, ownerId, ownerId)) met(m.owner_id, m.email, m.ended);
  // Repeating ones: the times they happened that ended in the window (moved or cancelled ones as they are).
  const repeating = q(`SELECT DISTINCT e.* FROM events e JOIN event_outside_guests g ON g.event_id = e.id
                       WHERE e.rrule IS NOT NULL AND e.start <= ? AND (e.repeat_until IS NULL OR e.repeat_until > ?) AND (? IS NULL OR e.owner_id = ?)`).all(at, at - within, ownerId, ownerId); // not ones that stopped repeating before the window
  for (const row of repeating) {
    const ends = expand(outEvent(row), at - within - 864e5, at).map((o) => o.end).filter((t) => t <= at && t > at - within);
    if (!ends.length) continue;
    const last = Math.max(...ends);
    for (const g of q("SELECT LOWER(email) AS email FROM event_outside_guests WHERE event_id = ? AND status != 'no'").all(row.id)) met(row.owner_id, g.email, last);
  }
  let n = 0;
  for (const [k, ended] of pairs) {
    const [owner, email] = k.split('\u0000');
    n += q('UPDATE contacts SET last_contact = ? WHERE owner_id = ? AND LOWER(email) = ? AND (last_contact IS NULL OR last_contact < ?)').run(ended, owner, email, ended).changes;
  }
  return n;
}

export function notifyDueTouches(at = Date.now()) {
  const due = q('SELECT id, owner_id, name, touch_days, last_contact, touch_notified FROM contacts WHERE touch_days IS NOT NULL AND last_contact IS NOT NULL').all()
    .map((c) => ({ ...c, due: touchDue(c) })).filter((c) => c.due <= at && !(c.touch_notified >= c.due));
  const byOwner = new Map();
  for (const c of due) byOwner.set(c.owner_id, [...(byOwner.get(c.owner_id) || []), c]);
  for (const [owner, list] of byOwner) {
    list.sort((a, b) => a.due - b.due);
    const more = list.length - 1;
    notify([owner], { kind: 'touch', title: `Time to catch up with ${list[0].name}${more ? ` and ${more} other${more === 1 ? '' : 's'}` : ''}`, body: 'It’s been longer than you wanted.', link: '/contacts?tab=touch' });
    for (const c of list) q('UPDATE contacts SET touch_notified = ? WHERE id = ?').run(c.due, c.id);
  }
  return byOwner.size;
}
liftCardMore(); // cards synced before kept their other addresses and numbers inside the raw card

const FIELDS = { name: 200, email: 200, phone: 50, company: 200, title: 200, address: 500, website: 300, notes: 5000 };
const COLS = [...Object.keys(FIELDS), 'birthday'];
/** A web address as kept: with https:// added when it's left off. */
const websiteOf = (v) => (!v ? v : /^https?:\/\//i.test(v) ? v : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) ? `https://${v}` : (() => { throw bad('Website must be a web address, like example.com'); })());

// Groups: your own lists of people (contacts or colleagues, by address) to email all at once.
q(`CREATE TABLE IF NOT EXISTS contact_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  members TEXT NOT NULL,              -- JSON [{ name, email }]
  created_at INTEGER NOT NULL
)`).run();
const MAX_GROUPS = 200, MAX_MEMBERS = 500;
// Company contacts: a contact its owner shares with everyone in their company (suppliers, clients, a
// shared phone list). Others see it, and find it when writing mail; its owner (or an admin) changes it.
if (!q('PRAGMA table_info(contacts)').all().some((c) => c.name === 'shared')) q('ALTER TABLE contacts ADD COLUMN shared INTEGER NOT NULL DEFAULT 0').run();
// Starred: the people you deal with most, first in your contacts and in suggestions while writing mail.
if (!q('PRAGMA table_info(contacts)').all().some((c) => c.name === 'starred')) q('ALTER TABLE contacts ADD COLUMN starred INTEGER NOT NULL DEFAULT 0').run();
const EMAIL_RE = /^[^\s@<>"(),;:\\]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
export const groupsOf = (userId) => q('SELECT id, name, members FROM contact_groups WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(userId).map((g) => ({ ...g, members: JSON.parse(g.members) }));
/** Groups from a Download your data .zip ([{ name, members }]): each name not taken here is added. { added, skipped } */
export function importGroups(userId, list) {
  let added = 0, skipped = 0;
  const have = new Set(groupsOf(userId).map((g) => g.name.toLowerCase()));
  for (const g of Array.isArray(list) ? list : []) {
    const name = String(g?.name || '').trim().slice(0, 100);
    if (!name || have.has(name.toLowerCase()) || have.size >= MAX_GROUPS) { skipped++; continue; }
    let members;
    try { members = readMembers(g.members || []); } catch { skipped++; continue; }
    q('INSERT INTO contact_groups (id, owner_id, name, members, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), userId, name, JSON.stringify(members), now());
    have.add(name.toLowerCase()); added++;
  }
  return { added, skipped };
}
/** A new group of someone's ([{ name, email }], each address once): its name must be new to them. The group. */
export function makeGroup(userId, nameIn, members) {
  const name = str(nameIn, { required: true, name: 'Group name', max: 100 });
  const mine = groupsOf(userId);
  if (mine.length >= MAX_GROUPS) throw bad('Too many groups');
  if (mine.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw bad('You already have a group with that name');
  const id = uid();
  q('INSERT INTO contact_groups (id, owner_id, name, members, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, name, JSON.stringify(readMembers(members)), now());
  return groupsOf(userId).find((g) => g.id === id);
}
function readMembers(list) {
  if (!Array.isArray(list)) throw bad('Members must be a list');
  const seen = new Set(), out = [];
  for (const m of list) {
    const email = String(m?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad(`Not an email address: ${email || '(empty)'}`);
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ name: String(m.name || '').trim().slice(0, 200), email });
  }
  if (out.length > MAX_MEMBERS) throw bad(`At most ${MAX_MEMBERS} people in a group`);
  return out;
}

function read(body, partial) {
  const out = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    if (partial && body[k] === undefined) continue;
    out[k] = str(body[k], { max, required: k === 'name', name: k });
  }
  if (out.website !== undefined) out.website = websiteOf(out.website);
  if (!partial || body.birthday !== undefined) {
    try { out.birthday = birthdayOf(body.birthday, { strict: true }); } catch (e) { throw bad(e.message); }
  }
  // Other dates ([{ label, date }]) and fields of your own ([{ label, value }]).
  if (body.dates !== undefined) { try { out.dates = JSON.stringify(cleanDates(body.dates, { strict: true })); } catch (e) { throw bad(e.message); } }
  if (body.custom_fields !== undefined) { try { out.custom_fields = JSON.stringify(cleanCustom(body.custom_fields, { strict: true })); } catch (e) { throw bad(e.message); } }
  // Other email addresses and phone numbers: [{ type, value }] (work, home, mobile, other).
  for (const k of ['emails', 'phones']) {
    if (body[`more_${k}`] === undefined) continue;
    try { out[`more_${k}`] = JSON.stringify(cleanMore(body[`more_${k}`], k, { strict: true, main: k === 'emails' ? body.email : body.phone })); } catch (e) { throw bad(e.message); }
  }
  return out;
}

// ---- sending a contact in Chat ----
/** What a contact you can see (yours, or one shared with your company) says, to pass on: no notes or dates. */
export function contactCard(id, user) {
  const c = q('SELECT c.*, u.org_id FROM contacts c JOIN users u ON u.id = c.owner_id WHERE c.id = ?').get(String(id || ''));
  if (!c || !(c.owner_id === user.id || (c.shared && c.org_id === user.org_id))) throw notFound('Contact not found');
  const m = withMore(c);
  const card = { name: c.name };
  for (const k of ['email', 'phone', 'company', 'title', 'address', 'website']) if (c[k]) card[k] = c[k];
  if (m.more_emails?.length) card.more_emails = m.more_emails;
  if (m.more_phones?.length) card.more_phones = m.more_phones;
  return card;
}
/** A colleague's card to pass on (someone at your company): name, address, job title, department as company, work phone. */
export function colleagueCard(userId, user) {
  const u = q("SELECT id, name, username, org_id, job_title, department, work_phone FROM users WHERE id = ? AND disabled = 0").get(String(userId || ''));
  if (!u || u.org_id !== user.org_id) throw notFound('Colleague not found');
  const org = q('SELECT name FROM orgs WHERE id = ?').get(u.org_id)?.name;
  const card = { name: u.name || u.username, email: u.username };
  if (u.job_title) card.title = u.job_title;
  card.company = [org, u.department].filter(Boolean).join(' · ') || undefined;
  if (!card.company) delete card.company;
  if (u.work_phone) card.phone = u.work_phone;
  return card;
}
/** Adds a passed-on contact to someone's own contacts (checked as if they'd typed it). An existing contact
 *  of theirs with the same email address is kept instead: { id, existing: true }. */
export function addContactFrom(user, card) {
  const email = String(card?.email || '').trim().toLowerCase();
  const had = email && q('SELECT id FROM contacts WHERE owner_id = ? AND LOWER(email) = ?').get(user.id, email);
  if (had) return { id: had.id, existing: true };
  const c = read({ ...card, notes: undefined }, false);
  const id = uid();
  q(`INSERT INTO contacts (id, owner_id, ${COLS.join(', ')}, created_at, shared, more_emails, more_phones) VALUES (?, ?, ${COLS.map(() => '?').join(', ')}, ?, 0, ?, ?)`)
    .run(id, user.id, ...COLS.map((k) => c[k] ?? null), now(), c.more_emails ?? null, c.more_phones ?? null);
  return { id, existing: false };
}

/** Contacts from a vCard or CSV file's text: those not already there are added. { added, skipped } */
export function importContacts(user, body) {
  const found = contactsFromFile(body);
  if (found.error) throw bad(found.error);
  if (found.contacts.length > MAX_IMPORT) throw bad(`At most ${MAX_IMPORT} contacts can be imported at once`);
  const have = q('SELECT LOWER(email) AS email, vcard_uid, LOWER(name) AS name, phone FROM contacts WHERE owner_id = ?').all(user.id);
  const emails = new Set(have.map((c) => c.email).filter(Boolean));
  const uids = new Set(have.map((c) => c.vcard_uid).filter(Boolean));
  const namePhone = new Set(have.map((c) => `${c.name}|${c.phone || ''}`));
  let added = 0, skipped = 0;
  const t = now();
  for (const c of found.contacts) {
    const email = c.email ? c.email.toLowerCase() : null;
    const key = `${String(c.name).toLowerCase()}|${c.phone || ''}`;
    if ((email && emails.has(email)) || (c.uid && uids.has(c.uid)) || (!email && namePhone.has(key))) { skipped++; continue; } // already there
    const cut = (v, n) => (v ? String(v).slice(0, n) : null);
    const newId = uid();
    q(`INSERT INTO contacts (id, owner_id, name, email, phone, company, title, address, website, notes, birthday, created_at, vcard_uid, vcard_extra, more_emails, more_phones) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId, user.id, String(c.name).slice(0, 200), email, cut(c.phone, 50), cut(c.company, 200), cut(c.title, 200), cut(c.address, 500), cut(c.website, 300),
        cut(c.notes, 5000), c.birthday || null, t, c.uid || null, c.vcard_extra || null,
        c.more_emails?.length ? JSON.stringify(c.more_emails) : null, c.more_phones?.length ? JSON.stringify(c.more_phones) : null);
    if (c.dates?.length || c.custom_fields?.length) q('UPDATE contacts SET dates = ?, custom_fields = ? WHERE id = ?').run(c.dates?.length ? JSON.stringify(c.dates) : null, c.custom_fields?.length ? JSON.stringify(c.custom_fields) : null, newId);
    if (c.photo) photoFromCard(newId, c);
    if (email) emails.add(email);
    if (c.uid) uids.add(c.uid);
    namePhone.add(key);
    added++;
  }
  return { added, skipped };
}

/**
 * Add people to someone's contacts ([{ name, email }]: from an email, an event, a form's responses): you, colleagues
 * and anyone already in your contacts are left out (skipped); bad addresses are ignored. { added, skipped, names }
 */
export function addPeople(user, list) {
  const people = Array.isArray(list) ? list.slice(0, 1000) : [];
  const have = new Set(q('SELECT LOWER(email) AS e FROM contacts WHERE owner_id = ? AND email IS NOT NULL').all(user.id).map((c) => c.e));
  const colleagues = new Set(q('SELECT LOWER(username) AS e FROM users WHERE org_id = ? AND disabled = 0').all(user.org_id).map((u) => u.e));
  const added = [];
  let skipped = 0;
  for (const p of people) {
    const email = String(p?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    if (have.has(email) || colleagues.has(email) || email === user.username.toLowerCase()) { skipped++; continue; }
    const name = (String(p?.name || '').replace(/[\r\n]+/g, ' ').trim() || email.split('@')[0]).slice(0, 200);
    q('INSERT INTO contacts (id, owner_id, name, email, created_at) VALUES (?, ?, ?, ?, ?)').run(uid(), user.id, name, email, now());
    have.add(email);
    added.push(name);
  }
  return { added: added.length, skipped, names: added.slice(0, 10) };
}

export default function contactRoutes() {
  const r = Router();
  watchContacts(); // every module has added its columns by now

  // Any change that worked: the person's other tabs and devices show it at once ("contacts-changed"), and for a
  // contact shared with the company (made, changed or deleted), everyone in it.
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const json = res.json.bind(res);
    res.json = (body) => { if (body && body.shared) res.locals.sharedContact = true; return json(body); };
    res.on('finish', () => {
      if (res.statusCode >= 300) return;
      const company = res.locals.sharedContact || req.body?.shared !== undefined;
      sendTo(company ? orgMemberIds(req.user.org_id) : [req.user.id], { type: 'contacts-changed' });
    });
    next();
  });

  // Undo changes: put your contacts back as they were at a time in the last HISTORY_DAYS days.
  // GET ?since= says how many have changed since then; POST { to } does it.
  const undoTime = (v) => {
    const t = Number(v);
    if (!Number.isFinite(t) || t >= Date.now()) throw bad('Pick a time in the past');
    if (t < Date.now() - HISTORY_DAYS * 86400000) throw bad(`Changes are kept for ${HISTORY_DAYS} days`);
    return t;
  };
  r.get('/undo', (req, res) => { sweepContactHistory(); res.json({ changed: changedSince(req.user.id, undoTime(req.query.since)), days: HISTORY_DAYS }); });
  r.post('/undo', (req, res) => {
    const n = undoContacts(req.user.id, undoTime(req.body?.to));
    if (n) sendTo([req.user.id], { type: 'contacts-changed' });
    res.json({ changed: n });
  });

  // Trash: deleted contacts, kept TRASH_DAYS days (contacttrash.js).
  r.get('/trash', (req, res) => { sweepContactTrash(); res.json({ days: TRASH_DAYS, contacts: trashOf(req.user.id) }); });
  r.post('/trash/:id/restore', (req, res) => {
    const id = restoreContact(String(req.params.id), req.user.id);
    if (!id) throw notFound('Not in your trash');
    res.json(withMore(q('SELECT * FROM contacts WHERE id = ?').get(id)));
  });
  r.delete('/trash/:id', (req, res) => { if (!purgeTrash(req.user.id, String(req.params.id))) throw notFound('Not in your trash'); res.json({ ok: true }); });
  r.delete('/trash', (req, res) => res.json({ deleted: purgeTrash(req.user.id) }));

  r.get('/', (req, res) => {
    if (req.query.scope === 'company') {
      return res.json(q(`SELECT c.*, u.name AS owner_name, (c.owner_id = ? OR ?) AS can_edit, p.updated_at AS photo_at FROM contacts c JOIN users u ON u.id = c.owner_id
                         LEFT JOIN contact_photos p ON p.contact_id = c.id WHERE c.shared = 1 AND u.org_id = ? ORDER BY c.name COLLATE NOCASE`).all(req.user.id, req.user.is_admin ? 1 : 0, req.user.org_id)
        .map((c) => withMore({ ...c, can_edit: !!c.can_edit })));
    }
    try { meetingsCountAsTouch(Date.now(), 2 * 864e5, req.user.id); } catch { /* counted hourly anyway */ }
    res.json(q('SELECT c.*, p.updated_at AS photo_at FROM contacts c LEFT JOIN contact_photos p ON p.contact_id = c.id WHERE c.owner_id = ? ORDER BY c.starred DESC, c.name COLLATE NOCASE').all(req.user.id).map((c) => withMore({ ...c, starred: !!c.starred })));
  });

  // ---- photos ----
  // Which of your contacts (and the company's shared ones) have a photo, by email address: Mail and
  // elsewhere show them for people who aren't colleagues.
  r.get('/photos', (req, res) => {
    res.json(q(`SELECT c.id, LOWER(c.email) AS email, p.updated_at AS v FROM contacts c JOIN contact_photos p ON p.contact_id = c.id JOIN users u ON u.id = c.owner_id
                WHERE c.email IS NOT NULL AND c.email != '' AND (c.owner_id = ? OR (c.shared = 1 AND u.org_id = ?))
                ORDER BY c.owner_id = ? DESC`).all(req.user.id, req.user.org_id, req.user.id)
      .map((x) => ({ email: x.email, url: `/api/contacts/${x.id}/photo?v=${x.v}` })));
  });
  const photoChanged = (c) => {
    const org = q('SELECT org_id FROM users WHERE id = ?').get(c.owner_id)?.org_id;
    sendTo(c.shared && org ? orgMemberIds(org) : [c.owner_id], { type: 'photos-changed' });
  };
  // Seen by whoever sees the contact: its owner, or everyone in the company for a shared one.
  r.get('/:id/photo', (req, res) => {
    const c = q('SELECT c.id, c.owner_id, c.shared, u.org_id FROM contacts c JOIN users u ON u.id = c.owner_id WHERE c.id = ?').get(req.params.id);
    if (!c || !(c.owner_id === req.user.id || (c.shared && c.org_id === req.user.org_id))) throw notFound();
    const p = photoOf(c.id);
    if (!p) throw notFound('No photo');
    res.setHeader('Content-Type', p.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(p.data));
  });
  r.put('/:id/photo', express.raw({ type: () => true, limit: MAX_PHOTO + 1024 }), (req, res) => {
    const c = editable(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Send the picture');
    let at;
    try { at = setPhoto(c.id, req.body); } catch (e) { throw bad(e.message); }
    photoChanged(c);
    res.json({ photo_at: at });
  });
  r.delete('/:id/photo', (req, res) => { const c = editable(req); setPhoto(c.id, null); photoChanged(c); res.json({ ok: true }); });

  // Suggestions while typing an address in Mail: your contacts and your colleagues.
  // ---- groups ----
  r.get('/groups', (req, res) => res.json(groupsOf(req.user.id)));
  r.post('/groups', (req, res) => res.status(201).json(makeGroup(req.user.id, req.body.name, req.body.members || [])));
  // A group from a spreadsheet (Sheets ⋮ → Make a contact group…): { file, sheet, name }, the sheet read as Import reads a
  // CSV (a Name and an Email column, as Gmail and Outlook write them); rows without an address are left out.
  r.post('/groups/from-sheet', async (req, res) => {
    const name = str(req.body?.name, { required: true, name: 'Group name', max: 100 });
    const mine = groupsOf(req.user.id);
    if (mine.length >= MAX_GROUPS) throw bad('Too many groups');
    if (mine.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw bad('You already have a group with that name');
    const found = contactsFromFile(await sheetAsCsv(req.body?.file, req.body?.sheet, req.user));
    if (found.error) throw bad('This sheet isn’t laid out as contacts: give it an Email column (and Name, if you like)');
    const people = found.contacts.filter((c) => c.email && EMAIL_RE.test(c.email)).map((c) => ({ name: c.name || '', email: c.email }));
    if (!people.length) throw bad('No email addresses on this sheet');
    const members = readMembers(people.slice(0, MAX_MEMBERS + 1));
    const id = uid();
    q('INSERT INTO contact_groups (id, owner_id, name, members, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.user.id, name, JSON.stringify(members), now());
    res.status(201).json({ ...groupsOf(req.user.id).find((g) => g.id === id), left_out: found.contacts.length - people.length });
  });
  const ownGroup = (req) => { const g = groupsOf(req.user.id).find((x) => x.id === req.params.id); if (!g) throw notFound('Group not found'); return g; };
  r.patch('/groups/:id', (req, res) => {
    const g = ownGroup(req);
    const name = req.body.name !== undefined ? str(req.body.name, { required: true, name: 'Group name', max: 100 }) : g.name;
    if (groupsOf(req.user.id).some((x) => x.id !== g.id && x.name.toLowerCase() === name.toLowerCase())) throw bad('You already have a group with that name');
    const members = req.body.members !== undefined ? readMembers(req.body.members) : g.members;
    q('UPDATE contact_groups SET name = ?, members = ? WHERE id = ?').run(name, JSON.stringify(members), g.id);
    res.json(groupsOf(req.user.id).find((x) => x.id === g.id));
  });
  // A group in a new spreadsheet: each member's name and address, with the phone, company and job title of
  // the contact they are (if they're one of yours), the heading row bold and kept in view.
  r.post('/groups/:id/sheet', (req, res) => {
    const g = ownGroup(req);
    if (!g.members.length) throw bad('This group has nobody in it yet');
    const mine = new Map(q('SELECT LOWER(email) AS e, name, phone, company, title FROM contacts WHERE owner_id = ? AND email IS NOT NULL').all(req.user.id).map((c) => [c.e, c]));
    const phone = (v) => (v && /^[\d\s()+.-]{6,}$/.test(v) && /\d/.test(v) ? `'${v}` : v || ''); // (a phone stays as written)
    const rows = [['Name', 'Email', 'Phone', 'Company', 'Job title'], ...g.members.map((m) => {
      const c = mine.get(m.email.toLowerCase());
      return [m.name || c?.name || '', m.email, phone(c?.phone), c?.company || '', c?.title || ''];
    })];
    const json = JSON.stringify(sheetFromRows(rows, { header: true, name: g.name.slice(0, 31) }));
    const id = insertFile({ owner: req.user.id, parentId: null, name: `${g.name} (group)`.slice(0, 200), kind: 'sheet', content: json, size: Buffer.byteLength(json) });
    res.status(201).json({ id, name: q('SELECT name FROM files WHERE id = ?').get(id).name, members: g.members.length });
  });
  r.delete('/groups/:id', (req, res) => { const g = ownGroup(req); res.json({ ok: true, bin_id: binAndDelete('contact_group', g.id, { ownerId: req.user.id, name: g.name, by: req.user.id }) }); });
  r.post('/groups/bin/:id/restore', (req, res) => {
    const back = restoreFromBin(req.params.id, req.user.id);
    if (!back || back.kind !== 'contact_group') throw notFound('Not in your recently deleted groups');
    res.json({ ok: true, id: back.item_id });
  });

  // People you've emailed who aren't in your contacts.
  r.get('/other', (req, res) => res.json(otherContactsOf(req.user.id)));
  // Frequently contacted: who you email most (from Workspace, the last six months).
  r.get('/frequent', (req, res) => res.json(frequentOf(req.user)));
  // Forget who you write to: one person (?email=) or everyone. Also what "Include …?" in Mail suggests.
  r.delete('/frequent', (req, res) => res.json({ forgotten: forgetSent(req.user, req.query.email ? String(req.query.email) : null) }));
  r.delete('/other/:email', (req, res) => {
    if (!forgetOther(req.user.id, req.params.email)) throw notFound();
    res.json({ ok: true });
  });

  r.get('/suggest', (req, res) => {
    const term = fold(String(req.query.q || '').trim()); // (accents don't matter: zoe finds Zoë)
    if (!term) return res.json([]);
    // Your groups whose name matches come first: picking one puts in everyone in it.
    const groups = groupsOf(req.user.id).filter((g) => g.members.length && fold(g.name).includes(term)).slice(0, 3)
      .map((g) => ({ kind: 'group', name: g.name, email: `group:${g.id}`, members: g.members }));
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const starts = `${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const company = q(`SELECT c.name, c.email FROM contacts c JOIN users u ON u.id = c.owner_id WHERE c.shared = 1 AND u.org_id = ? AND c.owner_id != ? AND c.email IS NOT NULL AND c.email != ''
                    AND (fold(c.name) LIKE ? ESCAPE '\\' OR fold(c.email) LIKE ? ESCAPE '\\') ORDER BY c.name COLLATE NOCASE LIMIT 8`).all(req.user.org_id, req.user.id, like, like);
    const mine = q(`SELECT name, email, starred FROM contacts WHERE owner_id = ? AND email IS NOT NULL AND email != ''
                    AND (fold(name) LIKE ? ESCAPE '\\' OR fold(email) LIKE ? ESCAPE '\\')
                    ORDER BY starred DESC, (fold(name) LIKE ? ESCAPE '\\' OR fold(email) LIKE ? ESCAPE '\\') DESC, name COLLATE NOCASE LIMIT 8`).all(req.user.id, like, like, starts, starts);
    // Your contacts' other addresses (a work and a home one): each is a suggestion of its own.
    const extra = q(`SELECT name, more_emails, starred FROM contacts WHERE owner_id = ? AND more_emails IS NOT NULL AND more_emails != '[]'
                     AND (fold(name) LIKE ? ESCAPE '\\' OR fold(more_emails) LIKE ? ESCAPE '\\') LIMIT 20`).all(req.user.id, like, like)
      .flatMap((c) => cleanMore(c.more_emails, 'emails').filter((e) => fold(c.name).includes(term) || e.value.includes(term)).map((e) => ({ name: c.name, email: e.value, starred: c.starred })));
    mine.push(...extra);
    const others = matchOther(req.user.id, like);
    const people = q(`SELECT id, name, username AS email FROM users WHERE org_id = ? AND disabled = 0 AND id != ?
                      AND (fold(name) LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\') ORDER BY name COLLATE NOCASE LIMIT 25`).all(req.user.org_id, req.user.id, like, like);
    const seen = new Set();
    const out = [];
    const starredMine = mine.filter((p) => p.starred), restMine = mine.filter((p) => !p.starred);
    for (const [list, kind] of [[starredMine, 'contact'], [people, 'colleague'], [restMine, 'contact'], [company, 'contact'], [others, 'other']]) {
      for (const p of list) {
        const email = p.email.toLowerCase();
        if (seen.has(email) || (kind === 'colleague' && !canReach(req.user, p.id))) continue;
        seen.add(email);
        out.push({ name: p.name || '', email, kind });
      }
    }
    // Who you write to most comes first (after your starred contacts), the rest as they were.
    const times = sentTimes(req.user, out.map((p) => p.email));
    const starredSet = new Set(starredMine.map((p) => p.email.toLowerCase()));
    const ranked = out.map((p, i) => ({ p, i, star: starredSet.has(p.email) ? 1 : 0, n: times.get(p.email) || 0 }))
      .sort((a, b) => b.star - a.star || b.n - a.n || a.i - b.i).map((x) => x.p);
    res.json([...groups, ...ranked].slice(0, 8));
  });

  // Import a .vcf (one or many cards) or a CSV export (Gmail, Outlook, or Name/Email columns).
  r.post('/import', express.text({ type: () => true, limit: '20mb' }), (req, res) => {
    res.json(importContacts(req.user, req.body));
  });

  // Add rows to Contacts (Sheets): { file, sheet } — the sheet read as Import reads a CSV (Name, Email, Phone, Company…);
  // anyone already in your contacts isn't added twice.
  r.post('/from-sheet', async (req, res) => {
    const csv = await sheetAsCsv(req.body?.file, req.body?.sheet, req.user);
    try { res.json(importContacts(req.user, csv)); }
    catch (e) { if (/contacts file/.test(e.message)) throw bad('This sheet isn’t laid out as contacts: give it a Name or Email column (and Phone, Company, Job title, Address, Notes… if you like)'); throw e; }
  });

  // A colleague saved as a contact of yours (from their card): { user_id }, with their work phone, job title and the
  // company's name, so they sync to your phone with the rest. One already there (by address) is given back, not doubled.
  r.post('/from-colleague', (req, res) => {
    const u = q('SELECT id, name, username, job_title, work_phone, org_id FROM users WHERE id = ? AND disabled = 0').get(String(req.body?.user_id || ''));
    if (!u || u.org_id !== req.user.org_id) throw notFound('No such person');
    if (u.id === req.user.id) throw bad('That’s you');
    const had = q('SELECT * FROM contacts WHERE owner_id = ? AND LOWER(email) = ?').get(req.user.id, u.username.toLowerCase());
    if (had) return res.json({ ...withMore(had), already: true });
    const id = uid();
    q('INSERT INTO contacts (id, owner_id, name, email, phone, company, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, (u.name || u.username).slice(0, 200), u.username.toLowerCase(), u.work_phone || null, q('SELECT name FROM orgs WHERE id = ?').get(u.org_id)?.name || null, u.job_title || null, now());
    res.status(201).json(withMore(q('SELECT * FROM contacts WHERE id = ?').get(id)));
  });

  // Add everyone on an email to Contacts: { people: [{ name, email }] } (its sender and recipients). Colleagues, you, and
  // anyone already in your contacts are left out; a name missing is made from the address.
  r.post('/add-people', (req, res) => {
    const r2 = addPeople(req.user, Array.isArray(req.body?.people) ? req.body.people.slice(0, 200) : []);
    if (!r2.added && !r2.skipped) throw bad('No email addresses to add');
    res.json(r2);
  });

  // Is this address one of your contacts, or a colleague? (For "Add to contacts" on a message.)
  r.get('/lookup', (req, res) => {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw bad('Not an email address');
    const contact = q('SELECT id, name FROM contacts WHERE owner_id = ? AND LOWER(email) = ?').get(req.user.id, email) || null;
    const colleague = !!q('SELECT 1 FROM users WHERE org_id = ? AND LOWER(username) = ? AND disabled = 0').get(req.user.org_id, email);
    res.json({ contact, colleague });
  });

  // Your contacts' birthdays between two dates (YYYY-MM-DD, at most a year and a bit apart), for the calendar.
  // Birthday and date reminders: { when: 'off' | 'day' | 'before', tz } (tz: your time zone, for the morning).
  r.get('/reminders', (req, res) => { const p = q('SELECT remind, remind_tz FROM contact_prefs WHERE user_id = ?').get(req.user.id); res.json({ when: p?.remind || 'off', tz: p?.remind_tz || null }); });
  r.put('/reminders', (req, res) => {
    const when = String(req.body?.when || '');
    if (when !== 'off' && !REMIND.includes(when)) throw bad('Remind on the day, the day before, or not at all');
    const asked = req.body?.tz ? String(req.body.tz).slice(0, 64) : null;
    const tz = asked ? zoneOrUtc(asked) : null; // as the server names it (old names are fine)
    if (asked && tz === 'UTC' && !/^(utc|etc\/utc|gmt|etc\/gmt)$/i.test(asked)) throw bad('Unknown time zone');
    q(`INSERT INTO contact_prefs (user_id, remind, remind_tz) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET remind = excluded.remind, remind_tz = COALESCE(excluded.remind_tz, contact_prefs.remind_tz),
         remind_last = CASE WHEN contact_prefs.remind IS excluded.remind THEN contact_prefs.remind_last ELSE NULL END`).run(req.user.id, when === 'off' ? null : when, tz); // a new choice counts from today
    res.json({ when, tz: q('SELECT remind_tz FROM contact_prefs WHERE user_id = ?').get(req.user.id)?.remind_tz || null });
  });
  r.get('/view', (req, res) => res.json({ sort: q('SELECT sort FROM contact_prefs WHERE user_id = ?').get(req.user.id)?.sort || 'first' }));
  r.put('/view', (req, res) => {
    const sort = String(req.body?.sort || '');
    if (!CONTACT_SORTS.includes(sort)) throw bad('First name, last name, company, recently added or last in touch');
    q('INSERT INTO contact_prefs (user_id, sort) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET sort = excluded.sort').run(req.user.id, sort);
    res.json({ sort });
  });

  // Who you're due to be in touch with: most overdue first, with when you last were.
  r.get('/keep-in-touch', (req, res) => {
    const at = Date.now();
    res.json(q('SELECT id, name, email, phone, touch_days, last_contact FROM contacts WHERE owner_id = ? AND touch_days IS NOT NULL').all(req.user.id)
      .map((c) => ({ ...c, due_at: touchDue(c) })).filter((c) => c.due_at <= at).sort((a, b) => a.due_at - b.due_at || a.name.localeCompare(b.name)));
  });
  // The log: GET lists it; POST { kind, text, at? } adds an entry (a call or meeting counts as being in touch); DELETE removes one.
  const ownContact = (req) => { const c = editable(req); if (c.owner_id !== req.user.id) throw notFound(); return c; };
  r.get('/:id/log', (req, res) => {
    const c = ownContact(req);
    res.json(q('SELECT id, kind, text, at FROM contact_log WHERE contact_id = ? AND user_id = ? ORDER BY at DESC LIMIT 500').all(c.id, req.user.id));
  });
  r.post('/:id/log', (req, res) => {
    const c = ownContact(req);
    const kind = LOG_KINDS.includes(req.body?.kind) ? req.body.kind : 'note';
    const text = str(req.body?.text, { required: true, name: 'What happened', max: 2000 });
    const at = req.body?.at === undefined ? Date.now() : Number(req.body.at);
    if (!Number.isFinite(at) || at > Date.now() + 864e5 || at < Date.UTC(1970, 0, 2)) throw bad('Choose when it was');
    if (q('SELECT COUNT(*) AS n FROM contact_log WHERE contact_id = ?').get(c.id).n >= 1000) throw bad('This contact’s log is full');
    const id = uid();
    q('INSERT INTO contact_log (id, contact_id, user_id, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, c.id, req.user.id, kind, text, at);
    if (kind !== 'note') q('UPDATE contacts SET last_contact = MAX(COALESCE(last_contact, 0), ?) WHERE id = ?').run(Math.min(at, Date.now()), c.id); // Keep in touch
    res.status(201).json({ id, kind, text, at });
  });
  r.delete('/:id/log/:entry', (req, res) => {
    const c = ownContact(req);
    if (!q('DELETE FROM contact_log WHERE id = ? AND contact_id = ? AND user_id = ?').run(String(req.params.entry), c.id, req.user.id).changes) throw notFound();
    res.json({ ok: true });
  });

  // Mark that you've been in touch (a call, a meeting): the clock starts again.
  r.post('/:id/contacted', (req, res) => {
    const c = editable(req);
    if (c.owner_id !== req.user.id) throw bad('Only its owner keeps in touch');
    q('UPDATE contacts SET last_contact = ? WHERE id = ?').run(Date.now(), c.id);
    res.json(withMore(q('SELECT * FROM contacts WHERE id = ?').get(c.id)));
  });

  r.get('/birthdays', (req, res) => {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw bad('from and to are required');
    if (Date.parse(to) - Date.parse(from) > 400 * 864e5) throw bad('At most a year at a time');
    const out = [];
    for (const c of q('SELECT id, name, email, birthday, dates FROM contacts WHERE owner_id = ? AND (birthday IS NOT NULL OR dates IS NOT NULL)').all(req.user.id)) {
      const who = { contact_id: c.id, name: c.name, email: c.email || null }; // the email, to send wishes from Home
      for (const b of birthdaysBetween(c.birthday, from, to)) out.push({ ...who, ...b });
      // Their other dates too (an anniversary…): { label, years } instead of an age.
      for (const d of datesBetween(c.dates, from, to, birthdaysBetween)) out.push({ ...who, date: d.date, label: d.label, years: d.years });
    }
    res.json(out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)));
  });

  // Download all your contacts, as vCards (phones, Outlook, Apple) or CSV (Gmail, spreadsheets).
  r.get('/export', (req, res) => {
    // ?ids=a,b: just those (the ones ticked in the list); otherwise all of yours.
    const ids = req.query.ids !== undefined ? new Set(String(req.query.ids).split(',').map((x) => x.trim()).filter(Boolean)) : null;
    if (ids && !ids.size) throw bad('No contacts selected');
    let list = q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
    if (ids) {
      list = list.filter((c) => ids.has(c.id));
      if (list.length < ids.size) throw notFound('Contact not found');
    }
    const csv = req.query.format === 'csv';
    res.setHeader('Content-Type', csv ? 'text/csv; charset=utf-8' : 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts.${csv ? 'csv' : 'vcf'}"`);
    res.send(csv ? contactsToCsv(list) : contactsToVcf(list.map(withPhoto)));
  });

  // Open in Sheets: your contacts (all, or ?ids the ticked ones) as a new spreadsheet in My Drive, in the CSV's columns,
  // the heading row bold and kept in view; numbers such as phones stay as written.
  r.post('/sheet', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
    if (ids && !ids.size) throw bad('No contacts selected');
    let list = q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
    if (ids) { list = list.filter((c) => ids.has(c.id)); if (list.length < ids.size) throw notFound('Contact not found'); }
    if (!list.length) throw bad('You have no contacts yet');
    const rows = contactsTable(list).map((r, i) => (i ? r.map((v) => (/^[\d\s()+.-]{6,}$/.test(v) && /\d/.test(v) ? `'${v}` : v)) : r)); // (a phone stays as written)
    const json = JSON.stringify(sheetFromRows(rows, { header: true, name: 'Contacts' }));
    const id = insertFile({ owner: req.user.id, parentId: null, name: ids ? `Contacts (${list.length})` : 'Contacts', kind: 'sheet', content: json, size: Buffer.byteLength(json) });
    res.status(201).json({ id, name: q('SELECT name FROM files WHERE id = ?').get(id).name, contacts: list.length });
  });

  // One contact as a vCard to pass on (to a phone, by email, or as a QR code): what it says without your
  // notes, dates or photo. ?download=1 sends it as a .vcf file; otherwise the text, for a QR code.
  r.get('/:id/vcard', (req, res) => {
    const card = contactCard(req.params.id, req.user);
    const text = buildVcard({ ...card, id: req.params.id });
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    if (req.query.download === '1') {
      const name = (card.name || 'contact').replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 80) || 'contact';
      res.setHeader('Content-Disposition', `attachment; filename="contact.vcf"; filename*=UTF-8''${encodeURIComponent(name)}.vcf`);
    }
    res.send(text);
  });

  // Contacts that look like the same person (same email, phone or name), to merge.
  r.get('/duplicates', (req, res) => {
    res.json(duplicateGroups(q('SELECT * FROM contacts WHERE owner_id = ?').all(req.user.id)));
  });

  // Merge contacts into one: `keep` stays (its empty fields filled from the others, anything that
  // differs noted), the others are deleted. Phones see the change on their next sync.
  r.post('/merge', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String))];
    const keepId = String(req.body.keep || '');
    if (!ids.includes(keepId)) ids.unshift(keepId);
    if (ids.length < 2 || ids.length > 50) throw bad('Choose 2 to 50 contacts to merge');
    const rows = ids.map((id) => q('SELECT * FROM contacts WHERE id = ? AND owner_id = ?').get(id, req.user.id));
    if (rows.some((x) => !x)) throw notFound('A contact is gone');
    const keep = rows.find((x) => x.id === keepId);
    const others = rows.filter((x) => x.id !== keepId);
    const m = mergedFields(keep, others);
    tx(() => {
      q(`UPDATE contacts SET ${COLS.map((k) => `${k} = ?`).join(', ')}, more_emails = ?, more_phones = ? WHERE id = ?`).run(...COLS.map((k) => m[k] ?? null), JSON.stringify(m.more_emails), JSON.stringify(m.more_phones), keep.id);
      for (const o of others) q('DELETE FROM contacts WHERE id = ?').run(o.id);
    });
    res.json(withMore(q('SELECT * FROM contacts WHERE id = ?').get(keep.id)));
  });

  r.post('/', (req, res) => {
    // An id chosen by the app (a contact added offline): sending it again returns the contact made the first time.
    const want = typeof req.body?.id === 'string' && /^[A-Za-z0-9_-]{16,40}$/.test(req.body.id) ? req.body.id : null;
    if (want) {
      const had = q('SELECT * FROM contacts WHERE id = ?').get(want);
      if (had) { if (had.owner_id !== req.user.id) throw bad('That id is taken'); return res.json(withMore(had)); }
    }
    const c = read(req.body, false);
    const id = want || uid();
    q(`INSERT INTO contacts (id, owner_id, ${COLS.join(', ')}, created_at, shared, more_emails, more_phones) VALUES (?, ?, ${COLS.map(() => '?').join(', ')}, ?, ?, ?, ?)`)
      .run(id, req.user.id, ...COLS.map((k) => c[k] ?? null), now(), req.body.shared ? 1 : 0, c.more_emails ?? null, c.more_phones ?? null);
    if (c.dates !== undefined || c.custom_fields !== undefined) q('UPDATE contacts SET dates = ?, custom_fields = ? WHERE id = ?').run(c.dates ?? null, c.custom_fields ?? null, id);
    res.status(201).json(withMore(q('SELECT * FROM contacts WHERE id = ?').get(id)));
  });

  // Yours, or (for an admin) one shared with the company.
  const editableBy = (id, user) => {
    const c = q('SELECT c.*, u.org_id FROM contacts c JOIN users u ON u.id = c.owner_id WHERE c.id = ?').get(String(id));
    if (!c || !(c.owner_id === user.id || (c.shared && user.is_admin && c.org_id === user.org_id))) throw notFound();
    const { org_id, ...row } = c;
    return row;
  };
  const editable = (req) => editableBy(req.params.id, req.user);

  // Several contacts at once: star or unstar them, add them to one of your groups (their email
  // addresses), or delete them. Each is checked first; if one can't be, none is changed.
  r.post('/batch', (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))];
    if (!ids.length) throw bad('Choose some contacts');
    if (ids.length > 1000) throw bad('1000 contacts at a time at most');
    const action = String(req.body?.action || '');
    const list = ids.map((id) => editableBy(id, req.user));
    if (action === 'delete') {
      for (const c of list) trashContact(c.id, req.user.id); // each one atomic (all were checked above)
      return res.json({ deleted: list.length });
    }
    if (action === 'star' || action === 'unstar') {
      if (list.some((c) => c.owner_id !== req.user.id)) throw bad('Only its owner stars a contact');
      tx(() => { for (const c of list) q('UPDATE contacts SET starred = ? WHERE id = ?').run(action === 'star' ? 1 : 0, c.id); });
      return res.json({ changed: list.length });
    }
    if (action === 'group') {
      const g = q('SELECT * FROM contact_groups WHERE id = ? AND owner_id = ?').get(String(req.body?.group_id || ''), req.user.id);
      if (!g) throw notFound('Group not found');
      const withEmail = list.filter((c) => c.email && EMAIL_RE.test(String(c.email).toLowerCase()));
      const before = JSON.parse(g.members);
      const members = readMembers([...before, ...withEmail.map((c) => ({ name: c.name, email: c.email }))]);
      q('UPDATE contact_groups SET members = ? WHERE id = ?').run(JSON.stringify(members), g.id);
      return res.json({ added: members.length - before.length, without_email: list.length - withEmail.length });
    }
    throw bad('Unknown action');
  });
  r.patch('/:id', (req, res) => {
    const existing = editable(req);
    const c = { ...existing, ...read(req.body, true) };
    q(`UPDATE contacts SET ${COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...COLS.map((k) => c[k] ?? null), c.id);
    for (const k of ['more_emails', 'more_phones', 'dates', 'custom_fields']) if (c[k] !== undefined && req.body[k] !== undefined) q(`UPDATE contacts SET ${k} = ? WHERE id = ?`).run(c[k], c.id);
    if (req.body.shared !== undefined) q('UPDATE contacts SET shared = ? WHERE id = ?').run(req.body.shared ? 1 : 0, c.id);
    if (req.body.touch_days !== undefined) {
      if (existing.owner_id !== req.user.id) throw bad('Only its owner keeps in touch');
      const d = req.body.touch_days === null || req.body.touch_days === '' ? null : Number(req.body.touch_days);
      if (d !== null && !TOUCH_DAYS.includes(d)) throw bad('Every week, 2 weeks, month, 2 months, 3 months, 6 months or year');
      q('UPDATE contacts SET touch_days = ? WHERE id = ?').run(d, c.id);
    }
    if (req.body.starred !== undefined) {
      if (existing.owner_id !== req.user.id) throw bad('Only its owner stars a contact');
      q('UPDATE contacts SET starred = ? WHERE id = ?').run(req.body.starred ? 1 : 0, c.id);
    }
    res.json(withMore(q('SELECT * FROM contacts WHERE id = ?').get(c.id)));
  });

  r.delete('/:id', (req, res) => {
    const c = editable(req);
    if (c.shared) res.locals.sharedContact = true;
    trashContact(c.id, req.user.id);
    res.json({ ok: true, trash_days: TRASH_DAYS });
  });

  return r;
}
