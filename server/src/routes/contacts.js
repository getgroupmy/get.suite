import { Router } from 'express';
import { q, tx } from '../db.js';
import express from 'express';
import { uid, now, str, notFound, bad } from '../util.js';
import { contactsFromFile, contactsToCsv, contactsToVcf, MAX_IMPORT } from '../contactfiles.js';
import { canReach, orgMemberIds } from '../tenancy.js';
import { sendTo } from '../hub.js';
import { birthdayOf, birthdaysBetween } from '../birthday.js';
import { duplicateGroups, mergedFields } from '../contactmerge.js';
import { otherContactsOf, matchOther, forgetOther } from '../othercontacts.js';
import { photoOf, setPhoto, withPhoto, photoFromCard, MAX_PHOTO } from '../contactphotos.js';

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
const groupsOf = (userId) => q('SELECT id, name, members FROM contact_groups WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(userId).map((g) => ({ ...g, members: JSON.parse(g.members) }));
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
  return out;
}

export default function contactRoutes() {
  const r = Router();

  r.get('/', (req, res) => {
    if (req.query.scope === 'company') {
      return res.json(q(`SELECT c.*, u.name AS owner_name, (c.owner_id = ? OR ?) AS can_edit, p.updated_at AS photo_at FROM contacts c JOIN users u ON u.id = c.owner_id
                         LEFT JOIN contact_photos p ON p.contact_id = c.id WHERE c.shared = 1 AND u.org_id = ? ORDER BY c.name COLLATE NOCASE`).all(req.user.id, req.user.is_admin ? 1 : 0, req.user.org_id)
        .map((c) => ({ ...c, can_edit: !!c.can_edit })));
    }
    res.json(q('SELECT c.*, p.updated_at AS photo_at FROM contacts c LEFT JOIN contact_photos p ON p.contact_id = c.id WHERE c.owner_id = ? ORDER BY c.starred DESC, c.name COLLATE NOCASE').all(req.user.id).map((c) => ({ ...c, starred: !!c.starred })));
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
  r.post('/groups', (req, res) => {
    const name = str(req.body.name, { required: true, name: 'Group name', max: 100 });
    const mine = groupsOf(req.user.id);
    if (mine.length >= MAX_GROUPS) throw bad('Too many groups');
    if (mine.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw bad('You already have a group with that name');
    const id = uid();
    q('INSERT INTO contact_groups (id, owner_id, name, members, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.user.id, name, JSON.stringify(readMembers(req.body.members || [])), now());
    res.status(201).json(groupsOf(req.user.id).find((g) => g.id === id));
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
  r.delete('/groups/:id', (req, res) => { q('DELETE FROM contact_groups WHERE id = ?').run(ownGroup(req).id); res.json({ ok: true }); });

  // People you've emailed who aren't in your contacts.
  r.get('/other', (req, res) => res.json(otherContactsOf(req.user.id)));
  r.delete('/other/:email', (req, res) => {
    if (!forgetOther(req.user.id, req.params.email)) throw notFound();
    res.json({ ok: true });
  });

  r.get('/suggest', (req, res) => {
    const term = String(req.query.q || '').trim().toLowerCase();
    if (!term) return res.json([]);
    // Your groups whose name matches come first: picking one puts in everyone in it.
    const groups = groupsOf(req.user.id).filter((g) => g.members.length && g.name.toLowerCase().includes(term)).slice(0, 3)
      .map((g) => ({ kind: 'group', name: g.name, email: `group:${g.id}`, members: g.members }));
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const starts = `${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const company = q(`SELECT c.name, c.email FROM contacts c JOIN users u ON u.id = c.owner_id WHERE c.shared = 1 AND u.org_id = ? AND c.owner_id != ? AND c.email IS NOT NULL AND c.email != ''
                    AND (LOWER(c.name) LIKE ? ESCAPE '\\' OR LOWER(c.email) LIKE ? ESCAPE '\\') ORDER BY c.name COLLATE NOCASE LIMIT 8`).all(req.user.org_id, req.user.id, like, like);
    const mine = q(`SELECT name, email, starred FROM contacts WHERE owner_id = ? AND email IS NOT NULL AND email != ''
                    AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')
                    ORDER BY starred DESC, (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\') DESC, name COLLATE NOCASE LIMIT 8`).all(req.user.id, like, like, starts, starts);
    const others = matchOther(req.user.id, like);
    const people = q(`SELECT id, name, username AS email FROM users WHERE org_id = ? AND disabled = 0 AND id != ?
                      AND (LOWER(name) LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\') ORDER BY name COLLATE NOCASE LIMIT 8`).all(req.user.org_id, req.user.id, like, like);
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
    res.json([...groups, ...out].slice(0, 8));
  });

  // Import a .vcf (one or many cards) or a CSV export (Gmail, Outlook, or Name/Email columns).
  r.post('/import', express.text({ type: () => true, limit: '20mb' }), (req, res) => {
    const found = contactsFromFile(req.body);
    if (found.error) throw bad(found.error);
    if (found.contacts.length > MAX_IMPORT) throw bad(`At most ${MAX_IMPORT} contacts can be imported at once`);
    const have = q('SELECT LOWER(email) AS email, vcard_uid, LOWER(name) AS name, phone FROM contacts WHERE owner_id = ?').all(req.user.id);
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
      q(`INSERT INTO contacts (id, owner_id, name, email, phone, company, title, address, website, notes, birthday, created_at, vcard_uid, vcard_extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId, req.user.id, String(c.name).slice(0, 200), email, cut(c.phone, 50), cut(c.company, 200), cut(c.title, 200), cut(c.address, 500), cut(c.website, 300),
          cut(c.notes, 5000), c.birthday || null, t, c.uid || null, c.vcard_extra || null);
      if (c.photo) photoFromCard(newId, c);
      if (email) emails.add(email);
      if (c.uid) uids.add(c.uid);
      namePhone.add(key);
      added++;
    }
    res.json({ added, skipped });
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
  r.get('/birthdays', (req, res) => {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw bad('from and to are required');
    if (Date.parse(to) - Date.parse(from) > 400 * 864e5) throw bad('At most a year at a time');
    const out = [];
    for (const c of q('SELECT id, name, birthday FROM contacts WHERE owner_id = ? AND birthday IS NOT NULL').all(req.user.id)) {
      for (const b of birthdaysBetween(c.birthday, from, to)) out.push({ contact_id: c.id, name: c.name, ...b });
    }
    res.json(out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)));
  });

  // Download all your contacts, as vCards (phones, Outlook, Apple) or CSV (Gmail, spreadsheets).
  r.get('/export', (req, res) => {
    const list = q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
    const csv = req.query.format === 'csv';
    res.setHeader('Content-Type', csv ? 'text/csv; charset=utf-8' : 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts.${csv ? 'csv' : 'vcf'}"`);
    res.send(csv ? contactsToCsv(list) : contactsToVcf(list.map(withPhoto)));
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
      q(`UPDATE contacts SET ${COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...COLS.map((k) => m[k] ?? null), keep.id);
      for (const o of others) q('DELETE FROM contacts WHERE id = ?').run(o.id);
    });
    res.json(q('SELECT * FROM contacts WHERE id = ?').get(keep.id));
  });

  r.post('/', (req, res) => {
    const c = read(req.body, false);
    const id = uid();
    q(`INSERT INTO contacts (id, owner_id, ${COLS.join(', ')}, created_at, shared) VALUES (?, ?, ${COLS.map(() => '?').join(', ')}, ?, ?)`)
      .run(id, req.user.id, ...COLS.map((k) => c[k] ?? null), now(), req.body.shared ? 1 : 0);
    res.status(201).json(q('SELECT * FROM contacts WHERE id = ?').get(id));
  });

  // Yours, or (for an admin) one shared with the company.
  const editable = (req) => {
    const c = q('SELECT c.*, u.org_id FROM contacts c JOIN users u ON u.id = c.owner_id WHERE c.id = ?').get(req.params.id);
    if (!c || !(c.owner_id === req.user.id || (c.shared && req.user.is_admin && c.org_id === req.user.org_id))) throw notFound();
    const { org_id, ...row } = c;
    return row;
  };
  r.patch('/:id', (req, res) => {
    const existing = editable(req);
    const c = { ...existing, ...read(req.body, true) };
    q(`UPDATE contacts SET ${COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...COLS.map((k) => c[k] ?? null), c.id);
    if (req.body.shared !== undefined) q('UPDATE contacts SET shared = ? WHERE id = ?').run(req.body.shared ? 1 : 0, c.id);
    if (req.body.starred !== undefined) {
      if (existing.owner_id !== req.user.id) throw bad('Only its owner stars a contact');
      q('UPDATE contacts SET starred = ? WHERE id = ?').run(req.body.starred ? 1 : 0, c.id);
    }
    res.json(q('SELECT * FROM contacts WHERE id = ?').get(c.id));
  });

  r.delete('/:id', (req, res) => {
    q('DELETE FROM contacts WHERE id = ?').run(editable(req).id);
    res.json({ ok: true });
  });

  return r;
}
