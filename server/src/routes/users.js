import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { q, tx, FILES_DIR } from '../db.js';
import { str, bad, notFound } from '../util.js';
import { requireAdmin, validatePassword, hashPassword, newUserRow } from '../auth.js';
import { validUsername } from './auth.js';

export default function userRoutes() {
  const r = Router();

  // Everyone: the organisation directory (for sharing, chat, contacts).
  r.get('/directory', (req, res) => {
    res.json(q('SELECT id, username, name, email FROM users WHERE disabled = 0 ORDER BY name').all());
  });

  r.use(requireAdmin);

  r.get('/', (req, res) => {
    res.json(q(`SELECT u.id, u.username, u.name, u.email, u.is_admin, u.disabled, u.created_at,
                  (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.owner_id = u.id) AS storage_used
                FROM users u ORDER BY u.name`).all());
  });

  r.post('/', (req, res) => {
    const username = validUsername(req.body.username);
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That username is taken');
    const name = str(req.body.name, { required: true, name: 'Name', max: 100 });
    validatePassword(req.body.password);
    const id = newUserRow({ username, name, email: str(req.body.email, { max: 200 }), password: req.body.password, is_admin: !!req.body.is_admin });
    res.status(201).json({ id });
  });

  r.patch('/:id', (req, res) => {
    const u = q('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw notFound();
    const self = u.id === req.user.id;
    const { name, email, is_admin, disabled, password } = req.body;
    if (name !== undefined) q('UPDATE users SET name = ? WHERE id = ?').run(str(name, { required: true, name: 'Name', max: 100 }), u.id);
    if (email !== undefined) q('UPDATE users SET email = ? WHERE id = ?').run(str(email, { max: 200 }), u.id);
    if (is_admin !== undefined) {
      if (self && !is_admin) throw bad('You cannot remove your own admin rights');
      q('UPDATE users SET is_admin = ? WHERE id = ?').run(is_admin ? 1 : 0, u.id);
    }
    if (disabled !== undefined) {
      if (self) throw bad('You cannot disable yourself');
      q('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, u.id);
      if (disabled) q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    if (password !== undefined) {
      validatePassword(password);
      q('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    res.json({ ok: true });
  });

  // Permanently delete a user and everything they own.
  r.delete('/:id', (req, res) => {
    if (req.params.id === req.user.id) throw bad('You cannot delete yourself');
    const stored = tx(() => {
      // Includes other people's files inside this user's folders (removed by cascade).
      const rows = q(`WITH RECURSIVE t(id) AS (
                        SELECT id FROM files WHERE owner_id = ?
                        UNION SELECT f.id FROM files f JOIN t ON f.parent_id = t.id)
                      SELECT storage FROM files WHERE id IN (SELECT id FROM t) AND storage IS NOT NULL`).all(req.params.id);
      const info = q('DELETE FROM users WHERE id = ?').run(req.params.id);
      if (!info.changes) throw notFound();
      return rows;
    });
    for (const { storage } of stored) fs.rm(path.join(FILES_DIR, storage), { force: true }, () => {});
    res.json({ ok: true });
  });

  return r;
}
