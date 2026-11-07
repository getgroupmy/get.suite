import { Router } from 'express';
import { q } from '../db.js';
import express from 'express';
import { uid, now, str, notFound, bad } from '../util.js';
import { contactsFromFile, contactsToCsv, contactsToVcf, MAX_IMPORT } from '../contactfiles.js';
import { canReach } from '../tenancy.js';

const FIELDS = { name: 200, email: 200, phone: 50, company: 200, notes: 5000 };

// Groups: your own lists of people (contacts or colleagues, by address) to email all at once.
q(`CREATE TABLE IF NOT EXISTS contact_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  members TEXT NOT NULL,              -- JSON [{ name, email }]
  created_at INTEGER NOT NULL
)`).run();
const MAX_GROUPS = 200, MAX_MEMBERS = 500;
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
  return out;
}

export default function contactRoutes() {
  const r = Router();

  r.get('/', (req, res) => {
    res.json(q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id));
  });

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

  r.get('/suggest', (req, res) => {
    const term = String(req.query.q || '').trim().toLowerCase();
    if (!term) return res.json([]);
    // Your groups whose name matches come first: picking one puts in everyone in it.
    const groups = groupsOf(req.user.id).filter((g) => g.members.length && g.name.toLowerCase().includes(term)).slice(0, 3)
      .map((g) => ({ kind: 'group', name: g.name, email: `group:${g.id}`, members: g.members }));
    const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const starts = `${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const mine = q(`SELECT name, email FROM contacts WHERE owner_id = ? AND email IS NOT NULL AND email != ''
                    AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')
                    ORDER BY (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\') DESC, name COLLATE NOCASE LIMIT 8`).all(req.user.id, like, like, starts, starts);
    const people = q(`SELECT id, name, username AS email FROM users WHERE org_id = ? AND disabled = 0 AND id != ?
                      AND (LOWER(name) LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\') ORDER BY name COLLATE NOCASE LIMIT 8`).all(req.user.org_id, req.user.id, like, like);
    const seen = new Set();
    const out = [];
    for (const [list, kind] of [[people, 'colleague'], [mine, 'contact']]) {
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
      q(`INSERT INTO contacts (id, owner_id, name, email, phone, company, notes, created_at, vcard_uid, vcard_extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid(), req.user.id, String(c.name).slice(0, 200), email, c.phone ? String(c.phone).slice(0, 50) : null, c.company ? String(c.company).slice(0, 200) : null,
          c.notes ? String(c.notes).slice(0, 5000) : null, t, c.uid || null, c.vcard_extra || null);
      if (email) emails.add(email);
      if (c.uid) uids.add(c.uid);
      namePhone.add(key);
      added++;
    }
    res.json({ added, skipped });
  });

  // Download all your contacts, as vCards (phones, Outlook, Apple) or CSV (Gmail, spreadsheets).
  r.get('/export', (req, res) => {
    const list = q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
    const csv = req.query.format === 'csv';
    res.setHeader('Content-Type', csv ? 'text/csv; charset=utf-8' : 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts.${csv ? 'csv' : 'vcf'}"`);
    res.send(csv ? contactsToCsv(list) : contactsToVcf(list));
  });

  r.post('/', (req, res) => {
    const c = read(req.body, false);
    const id = uid();
    q(`INSERT INTO contacts (id, owner_id, name, email, phone, company, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, req.user.id, c.name, c.email, c.phone, c.company, c.notes, now());
    res.status(201).json(q('SELECT * FROM contacts WHERE id = ?').get(id));
  });

  r.patch('/:id', (req, res) => {
    const existing = q('SELECT * FROM contacts WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
    if (!existing) throw notFound();
    const c = { ...existing, ...read(req.body, true) };
    q('UPDATE contacts SET name = ?, email = ?, phone = ?, company = ?, notes = ? WHERE id = ?')
      .run(c.name, c.email, c.phone, c.company, c.notes, c.id);
    res.json(q('SELECT * FROM contacts WHERE id = ?').get(c.id));
  });

  r.delete('/:id', (req, res) => {
    const info = q('DELETE FROM contacts WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
    if (!info.changes) throw notFound();
    res.json({ ok: true });
  });

  return r;
}
