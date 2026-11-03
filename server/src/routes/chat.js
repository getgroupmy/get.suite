import { Router } from 'express';
import { q, tx } from '../db.js';
import { uid, now, str, bad, notFound } from '../util.js';
import { sendTo, onlineUserIds } from '../hub.js';
import { canReach, orgMemberIds } from '../tenancy.js';

/**
 * Channels belong to one company (org_id set, dm_key NULL).
 * Direct messages have dm_key "a:b", org_id NULL, and may span companies.
 */
function loadChannel(id, user) {
  const c = q('SELECT * FROM channels WHERE id = ?').get(id);
  if (!c) throw notFound('Channel not found');
  if (c.dm_key) {
    if (!q('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(id, user.id)) throw notFound('Channel not found');
  } else if (c.org_id !== user.org_id) throw notFound('Channel not found');
  return c;
}

const membersOf = (c) => q('SELECT user_id FROM channel_members WHERE channel_id = ?').all(c.id).map((r) => r.user_id);
const audience = (c) => (c.dm_key ? membersOf(c) : orgMemberIds(c.org_id));

/** For a DM: may this user still write to it? (the other person may be in a company that closed external access) */
function dmOpen(c, user) {
  return membersOf(c).every((id) => id === user.id || canReach(user, id));
}

const MSG = `SELECT m.id, m.channel_id, m.user_id, m.body, m.created_at, u.name AS user_name
             FROM messages m LEFT JOIN users u ON u.id = m.user_id`;

export default function chatRoutes() {
  const r = Router();

  r.get('/channels', (req, res) => {
    const me = req.user.id;
    const rows = q(`SELECT c.id, c.name, c.dm_key,
                      (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at,
                      (SELECT u.name FROM channel_members cm JOIN users u ON u.id = cm.user_id
                        WHERE cm.channel_id = c.id AND cm.user_id != ? LIMIT 1) AS dm_name,
                      (SELECT o.name FROM channel_members cm JOIN users u ON u.id = cm.user_id JOIN orgs o ON o.id = u.org_id
                        WHERE cm.channel_id = c.id AND cm.user_id != ? AND u.org_id != ? LIMIT 1) AS dm_org
                    FROM channels c
                    WHERE (c.dm_key IS NULL AND c.org_id = ?)
                       OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
                    ORDER BY c.dm_key IS NOT NULL, c.name`).all(me, me, req.user.org_id, req.user.org_id, me);
    res.json({ channels: rows, online: onlineUserIds() });
  });

  r.post('/channels', (req, res) => {
    const name = str(req.body.name, { required: true, name: 'Channel name', max: 60 }).toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9_-]+$/.test(name)) throw bad('Channel names may contain letters, numbers, - and _');
    if (q('SELECT 1 FROM channels WHERE name = ? AND org_id = ?').get(name, req.user.org_id)) throw bad('Channel already exists');
    const id = uid();
    q('INSERT INTO channels (id, org_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.user.org_id, name, req.user.id, now());
    sendTo(orgMemberIds(req.user.org_id), { type: 'channels-changed' });
    res.status(201).json({ id, name });
  });

  // Find or create a direct-message channel with another user (any company that allows it).
  r.post('/dm', (req, res) => {
    const other = q('SELECT id FROM users WHERE id = ? AND disabled = 0').get(req.body.user_id);
    if (!other || !canReach(req.user, other.id)) throw bad('You cannot message that person');
    const ids = [req.user.id, other.id].sort();
    const key = ids.join(':');
    let c = q('SELECT id FROM channels WHERE dm_key = ?').get(key);
    if (!c) {
      c = { id: uid() };
      tx(() => {
        q('INSERT INTO channels (id, name, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, 'dm', key, req.user.id, now());
        for (const u of new Set(ids)) q('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(c.id, u);
      });
      sendTo(new Set(ids), { type: 'channels-changed' });
    }
    res.json({ id: c.id });
  });

  r.get('/channels/:id/messages', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    const before = Number(req.query.before) || 8.64e15;
    const rows = q(`${MSG} WHERE m.channel_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT 100`).all(c.id, before);
    res.json(rows.reverse());
  });

  r.post('/channels/:id/messages', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    if (c.dm_key && !dmOpen(c, req.user)) throw bad('External messaging is turned off for one of the companies');
    const body = str(req.body.body, { required: true, name: 'Message', max: 8000 });
    const id = uid();
    q('INSERT INTO messages (id, channel_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, c.id, req.user.id, body, now());
    const msg = q(`${MSG} WHERE m.id = ?`).get(id);
    sendTo(audience(c), { type: 'message', message: msg });
    res.status(201).json(msg);
  });

  r.delete('/messages/:id', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    const moderator = req.user.is_admin && !c.dm_key; // company admins moderate their own channels
    if (m.user_id !== req.user.id && !moderator) throw notFound();
    q('DELETE FROM messages WHERE id = ?').run(m.id);
    sendTo(audience(c), { type: 'message-deleted', id: m.id, channel_id: m.channel_id });
    res.json({ ok: true });
  });

  return r;
}
