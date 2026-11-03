import { Router } from 'express';
import { q } from '../db.js';
import { uid, now, str, notFound } from '../util.js';

const FIELDS = { name: 200, email: 200, phone: 50, company: 200, notes: 5000 };

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
