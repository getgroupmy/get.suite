import { notify } from '../notifications.js';
import { Router } from 'express';
import path from 'node:path';
import { q, tx, FILES_DIR } from '../db.js';
import { uid, now, str, bad, notFound, HttpError } from '../util.js';
import { roleFor } from '../access.js';
import { insertFile } from './files.js';

// Where each person has read up to in each conversation (for unread counts), and emoji reactions.
q(`CREATE TABLE IF NOT EXISTS channel_reads (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
)`).run();
q(`CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
)`).run();
const MAX_FILES = 10;
import { sendTo, onlineUserIds } from '../hub.js';
import { canReach, orgMemberIds } from '../tenancy.js';

/**
 * Channels belong to one company (org_id set, dm_key NULL).
 * Direct messages have dm_key "a:b", org_id NULL, and may span companies.
 */
function loadChannel(id, user) {
  const c = q('SELECT * FROM channels WHERE id = ?').get(id);
  if (!c) throw notFound('Channel not found');
  const member = () => !!q('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(id, user.id);
  if (c.dm_key || c.private) { if (!member()) throw notFound('Channel not found'); }
  else if (c.org_id !== user.org_id) throw notFound('Channel not found');
  return c;
}

const membersOf = (c) => q('SELECT user_id FROM channel_members WHERE channel_id = ?').all(c.id).map((r) => r.user_id);
const audience = (c) => (c.dm_key || c.private ? membersOf(c) : orgMemberIds(c.org_id));
const isGeneral = (c) => !c.dm_key && c.id === q('SELECT id FROM channels WHERE org_id = ? AND dm_key IS NULL ORDER BY created_at LIMIT 1').get(c.org_id)?.id;
/** May this person change the channel's name, privacy or archiving? Who made it, or a company admin. */
const canManage = (c, user) => !c.dm_key && (c.created_by === user.id || (user.is_admin && c.org_id === user.org_id));
const readOnly = (c) => { if (c.archived_at) throw bad('This channel is archived'); };

/** For a DM: may this user still write to it? (the other person may be in a company that closed external access) */
function dmOpen(c, user) {
  return membersOf(c).every((id) => id === user.id || canReach(user, id));
}

// Each message with its thread: how many replies, when the last came, and who replied (first few).
const MSG = `SELECT m.id, m.channel_id, m.user_id, m.body, m.created_at, m.edited_at, m.files, m.parent_id, u.name AS user_name,
               (SELECT COUNT(*) FROM messages t WHERE t.parent_id = m.id) AS reply_count,
               (SELECT MAX(t.created_at) FROM messages t WHERE t.parent_id = m.id) AS last_reply_at,
               (SELECT json_group_array(name) FROM (SELECT DISTINCT tu.name FROM messages t JOIN users tu ON tu.id = t.user_id
                 WHERE t.parent_id = m.id ORDER BY t.created_at LIMIT 3)) AS repliers
             FROM messages m LEFT JOIN users u ON u.id = m.user_id`;

/** Messages as the app shows them: attached files and reactions ({ emoji, users: [{ id, name }] }) included. */
function shape(rows) {
  if (!rows.length) return rows;
  const reactions = q(`SELECT r.message_id, r.emoji, r.user_id, u.name FROM message_reactions r LEFT JOIN users u ON u.id = r.user_id
                       WHERE r.message_id IN (SELECT value FROM json_each(?)) ORDER BY r.created_at`).all(JSON.stringify(rows.map((m) => m.id)));
  return rows.map((m) => {
    const mine = reactions.filter((r) => r.message_id === m.id);
    const byEmoji = [];
    for (const r of mine) {
      let e = byEmoji.find((x) => x.emoji === r.emoji);
      if (!e) byEmoji.push(e = { emoji: r.emoji, users: [] });
      e.users.push({ id: r.user_id, name: r.name || 'Someone' });
    }
    return { ...m, files: m.files ? JSON.parse(m.files) : [], reactions: byEmoji, repliers: m.repliers ? JSON.parse(m.repliers) : [] };
  });
}
const one = (id) => shape([q(`${MSG} WHERE m.id = ?`).get(id)].filter(Boolean))[0];

/**
 * Send a direct message from one person to another (opening their conversation if needed), as if
 * typed in Chat. Used for notices such as comment mentions. Returns false if they can't be reached.
 */
export function sendDirect(from, toUserId, body) {
  const other = q('SELECT id FROM users WHERE id = ? AND disabled = 0').get(toUserId);
  if (!other || other.id === from.id || !canReach(from, other.id)) return false;
  const ids = [from.id, other.id].sort();
  const key = ids.join(':');
  let c = q('SELECT * FROM channels WHERE dm_key = ?').get(key);
  if (!c) {
    const id = uid();
    tx(() => {
      q('INSERT INTO channels (id, name, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'dm', key, from.id, now());
      for (const u of ids) q('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, u);
    });
    c = q('SELECT * FROM channels WHERE id = ?').get(id);
    sendTo(new Set(ids), { type: 'channels-changed' });
  }
  if (!dmOpen(c, from)) return false;
  const mid = uid();
  q('INSERT INTO messages (id, channel_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(mid, c.id, from.id, String(body).slice(0, 8000), now());
  sendTo(audience(c), { type: 'message', message: one(mid) });
  return true;
}

/** "@someone@example.com" in a message: a notice to each person mentioned who is in the conversation. */
const MENTION_RE = /@([\w.+-]+@[\w.-]+\.[a-z]{2,})/gi;
function notifyMentions(c, from, msg) {
  const names = [...new Set([...String(msg.body).matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))].slice(0, 50);
  if (!names.length) return;
  const inIt = new Set(audience(c));
  const ids = q(`SELECT id FROM users WHERE LOWER(username) IN (SELECT value FROM json_each(?)) AND disabled = 0`).all(JSON.stringify(names))
    .map((u) => u.id).filter((id) => id !== from.id && inIt.has(id));
  if (ids.length) notify(ids, { kind: 'mention', title: `${from.name || from.username} mentioned you in ${c.dm_key ? 'a message' : `#${c.name}`}`, body: String(msg.body).slice(0, 200), link: `/chat/${c.id}`, actor: from.name });
  if (ids.length) sendTo(ids, { type: 'chat-mention', channel_id: c.id, message_id: msg.id, parent_id: msg.parent_id, from: from.name || from.username, text: String(msg.body).slice(0, 140) });
}

/** People from your own company (ids), for a private channel. */
function colleagues(user, list) {
  const ids = [...new Set((Array.isArray(list) ? list : []).map(String))];
  if (ids.length > 500) throw bad('Too many people');
  const ok = new Set(q(`SELECT id FROM users WHERE org_id = ? AND disabled = 0 AND id IN (SELECT value FROM json_each(?))`).all(user.org_id, JSON.stringify(ids)).map((u) => u.id));
  if (ids.some((id) => !ok.has(id))) throw bad('Private channels are for people in your company');
  return ids;
}

export default function chatRoutes() {
  const r = Router();

  r.get('/channels', (req, res) => {
    const me = req.user.id;
    const rows = q(`SELECT c.id, c.name, c.dm_key, c.private, c.topic, c.archived_at, c.created_by,
                      (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) AS member_count,
                      (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at,
                      (SELECT u.name FROM channel_members cm JOIN users u ON u.id = cm.user_id
                        WHERE cm.channel_id = c.id AND cm.user_id != ? LIMIT 1) AS dm_name,
                      (SELECT o.name FROM channel_members cm JOIN users u ON u.id = cm.user_id JOIN orgs o ON o.id = u.org_id
                        WHERE cm.channel_id = c.id AND cm.user_id != ? AND u.org_id != ? LIMIT 1) AS dm_org,
                      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND (m.user_id IS NULL OR m.user_id != ?)
                        AND m.created_at > COALESCE((SELECT read_at FROM channel_reads r WHERE r.channel_id = c.id AND r.user_id = ?), 0)
                        -- replies count only for people in that thread (who started it or replied)
                        AND (m.parent_id IS NULL OR EXISTS (SELECT 1 FROM messages t WHERE (t.id = m.parent_id OR t.parent_id = m.parent_id) AND t.user_id = ?))) AS unread,
                      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND (m.user_id IS NULL OR m.user_id != ?)
                        AND m.created_at > COALESCE((SELECT read_at FROM channel_reads r WHERE r.channel_id = c.id AND r.user_id = ?), 0)
                        AND INSTR(LOWER(m.body), LOWER(?)) > 0) AS mentions
                    FROM channels c
                    WHERE (c.dm_key IS NULL AND c.private = 0 AND c.org_id = ?)
                       OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
                    ORDER BY c.dm_key IS NOT NULL, c.archived_at IS NOT NULL, c.name`).all(me, me, req.user.org_id, me, me, me, me, me, `@${req.user.username}`, req.user.org_id, me);
    res.json({ channels: rows, online: onlineUserIds() });
  });

  r.post('/channels', (req, res) => {
    const name = str(req.body.name, { required: true, name: 'Channel name', max: 60 }).toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9_-]+$/.test(name)) throw bad('Channel names may contain letters, numbers, - and _');
    if (q('SELECT 1 FROM channels WHERE name = ? AND org_id = ?').get(name, req.user.org_id)) throw bad('Channel already exists');
    const priv = !!req.body.private;
    const topic = str(req.body.topic, { max: 250, name: 'Topic' }) || null;
    const members = priv ? colleagues(req.user, req.body.members) : [];
    const id = uid();
    tx(() => {
      q('INSERT INTO channels (id, org_id, name, created_by, created_at, private, topic) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.user.org_id, name, req.user.id, now(), priv ? 1 : 0, topic);
      for (const m of new Set([req.user.id, ...members])) if (priv) q('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(id, m);
    });
    sendTo(priv ? [req.user.id, ...members] : orgMemberIds(req.user.org_id), { type: 'channels-changed' });
    res.status(201).json({ id, name });
  });

  // Settings: the topic (anyone in it); the name, privacy and archiving (whoever made it, or an admin).
  r.patch('/channels/:id', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    if (c.dm_key) throw bad('Direct messages have no settings');
    const b = req.body || {};
    const set = {};
    if (b.topic !== undefined) { if (c.archived_at && b.archived !== false) readOnly(c); set.topic = str(b.topic, { max: 250, name: 'Topic' }) || null; }
    if (b.name !== undefined || b.private !== undefined || b.archived !== undefined) {
      if (!canManage(c, req.user)) throw new HttpError(403, 'Only whoever made the channel, or an admin, can change that');
      if (isGeneral(c) && (b.private || b.archived)) throw bad('The company-wide channel stays open to everyone');
    }
    if (b.name !== undefined) {
      const name = str(b.name, { required: true, name: 'Channel name', max: 60 }).toLowerCase().replace(/\s+/g, '-');
      if (!/^[a-z0-9_-]+$/.test(name)) throw bad('Channel names may contain letters, numbers, - and _');
      if (name !== c.name && q('SELECT 1 FROM channels WHERE name = ? AND org_id = ?').get(name, c.org_id)) throw bad('Channel already exists');
      set.name = name;
    }
    if (b.archived !== undefined) set.archived_at = b.archived ? now() : null;
    const before = audience(c);
    tx(() => {
      if (b.private !== undefined && !!b.private !== !!c.private) {
        set.private = b.private ? 1 : 0;
        // Made private: those who've written in it (and you) become its members.
        if (b.private) for (const m of new Set([req.user.id, ...q('SELECT DISTINCT user_id FROM messages WHERE channel_id = ? AND user_id IS NOT NULL').all(c.id).map((x) => x.user_id)])) {
          q('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(c.id, m);
        }
        else q('DELETE FROM channel_members WHERE channel_id = ?').run(c.id);
      }
      const keys = Object.keys(set);
      if (keys.length) q(`UPDATE channels SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), c.id);
    });
    const after = q('SELECT * FROM channels WHERE id = ?').get(c.id);
    sendTo(new Set([...before, ...audience(after)]), { type: 'channels-changed' });
    res.json({ ok: true });
  });

  // Members of a private channel: anyone in it can add people; whoever made it (or an admin) can take them off.
  r.get('/channels/:id/members', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    const ids = c.dm_key || c.private ? membersOf(c) : orgMemberIds(c.org_id);
    res.json(q(`SELECT id, name, username FROM users WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name COLLATE NOCASE`).all(JSON.stringify(ids)));
  });
  r.post('/channels/:id/members', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    if (!c.private) throw bad('Everyone in the company can see this channel');
    readOnly(c);
    const add = colleagues(req.user, req.body.user_ids);
    for (const m of add) q('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(c.id, m);
    sendTo(membersOf(c), { type: 'channels-changed' });
    res.json({ ok: true });
  });
  r.delete('/channels/:id/members/:userId', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    if (!c.private) throw bad('Everyone in the company can see this channel');
    const who = req.params.userId === 'me' ? req.user.id : req.params.userId;
    if (who !== req.user.id && !canManage(c, req.user)) throw new HttpError(403, 'Only whoever made the channel, or an admin, can take people off');
    const before = membersOf(c);
    q('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(c.id, who);
    sendTo(before, { type: 'channels-changed' });
    res.json({ ok: true });
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
    // ?around=<message id>: the messages either side of one (to jump to a search result).
    if (req.query.around) {
      const m = q('SELECT created_at FROM messages WHERE id = ? AND channel_id = ? AND parent_id IS NULL').get(String(req.query.around), c.id);
      if (!m) throw notFound('Message not found');
      const older = q(`${MSG} WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.created_at < ? ORDER BY m.created_at DESC LIMIT 50`).all(c.id, m.created_at).reverse();
      const newer = q(`${MSG} WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.created_at >= ? ORDER BY m.created_at LIMIT 50`).all(c.id, m.created_at);
      return res.json(shape([...older, ...newer]));
    }
    const before = Number(req.query.before) || 8.64e15;
    const rows = q(`${MSG} WHERE m.channel_id = ? AND m.parent_id IS NULL AND m.created_at < ? ORDER BY m.created_at DESC LIMIT 100`).all(c.id, before);
    res.json(shape(rows.reverse()));
  });

  // Search: messages with all these words, in the conversations you can see (thread replies too),
  // newest first. Each says where it is: the conversation, and the thread it's in.
  r.get('/search', (req, res) => {
    const words = String(req.query.q || '').toLowerCase().match(/[\p{L}\p{N}@._-]+/gu)?.slice(0, 8) || [];
    if (!words.length) return res.json([]);
    const me = req.user.id;
    const like = words.map(() => "LOWER(m.body) LIKE ? ESCAPE '!'");
    const rows = q(`SELECT m.id, m.channel_id, m.parent_id, m.user_id, m.body, m.created_at, u.name AS user_name, c.name AS channel_name, c.dm_key, c.private,
                      (SELECT un.name FROM channel_members cm JOIN users un ON un.id = cm.user_id WHERE cm.channel_id = c.id AND cm.user_id != ? LIMIT 1) AS dm_name
                    FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id
                    WHERE ${like.join(' AND ')}
                      AND ((c.dm_key IS NULL AND c.private = 0 AND c.org_id = ?) OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
                    ORDER BY m.created_at DESC LIMIT 50`)
      .all(me, ...words.map((w) => `%${w.replace(/[%_!]/g, (x) => `!${x}`)}%`), req.user.org_id, me);
    res.json(rows.map((r) => ({ ...r, where: r.dm_key ? (r.dm_name || 'Notes to self') : `#${r.channel_name}`, private: !!r.private, dm_key: undefined, dm_name: undefined })));
  });

  // A thread: the message and its replies, oldest first.
  r.get('/messages/:id/replies', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m || m.parent_id) throw notFound('Message not found');
    loadChannel(m.channel_id, req.user);
    res.json({ message: one(m.id), replies: shape(q(`${MSG} WHERE m.parent_id = ? ORDER BY m.created_at LIMIT 1000`).all(m.id)) });
  });

  r.post('/channels/:id/messages', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    if (c.dm_key && !dmOpen(c, req.user)) throw bad('External messaging is turned off for one of the companies');
    readOnly(c);
    // Files from Drive the sender can open; everyone in the conversation can then open them from it.
    const ids = Array.isArray(req.body.files) ? [...new Set(req.body.files.map(String))] : [];
    if (ids.length > MAX_FILES) throw bad(`At most ${MAX_FILES} files per message`);
    const files = ids.map((fid) => {
      const f = q("SELECT id, name, mime, size, kind FROM files WHERE id = ? AND trashed = 0").get(fid);
      if (!f || f.kind !== 'file' || !roleFor(f.id, req.user.id)) throw bad('A file is not available');
      return { id: f.id, name: f.name, mime: f.mime || 'application/octet-stream', size: f.size };
    });
    const body = str(req.body.body, { required: !files.length, name: 'Message', max: 8000 }) || '';
    // A reply goes in the thread of a message in this conversation (threads don't nest).
    let parent = null;
    if (req.body.parent_id) {
      parent = q('SELECT id, parent_id, channel_id FROM messages WHERE id = ?').get(String(req.body.parent_id));
      if (!parent || parent.channel_id !== c.id) throw bad('That message is gone');
      if (parent.parent_id) parent = { id: parent.parent_id };
    }
    const id = uid();
    q('INSERT INTO messages (id, channel_id, user_id, body, created_at, files, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, c.id, req.user.id, body, now(), files.length ? JSON.stringify(files) : null, parent?.id ?? null);
    q('INSERT INTO channel_reads (channel_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET read_at = excluded.read_at').run(c.id, req.user.id, now());
    const msg = one(id);
    sendTo(audience(c), { type: 'message', message: msg });
    notifyMentions(c, req.user, msg);
    if (parent) sendTo(audience(c), { type: 'message-updated', message: one(parent.id) }); // its reply count
    res.status(201).json(msg);
  });

  // Read up to now: unread counts go back to zero (on your other devices too).
  r.post('/channels/:id/read', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    q('INSERT INTO channel_reads (channel_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)').run(c.id, req.user.id, now());
    sendTo([req.user.id], { type: 'chat-read', channel_id: c.id });
    res.json({ ok: true });
  });

  // Change your own message.
  r.patch('/messages/:id', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    if (m.user_id !== req.user.id) throw notFound();
    readOnly(c);
    const body = str(req.body.body, { required: !m.files, name: 'Message', max: 8000 }) || '';
    q('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), m.id);
    const msg = one(m.id);
    sendTo(audience(c), { type: 'message-updated', message: msg });
    res.json(msg);
  });

  // React with an emoji, or take your reaction back.
  r.post('/messages/:id/reactions', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    readOnly(c);
    const emoji = String(req.body.emoji || '').trim();
    if (!emoji || emoji.length > 16 || /[\s<>]/.test(emoji)) throw bad('Choose an emoji');
    const had = q('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, req.user.id, emoji).changes;
    if (!had) {
      if (q('SELECT COUNT(DISTINCT emoji) AS n FROM message_reactions WHERE message_id = ?').get(m.id).n >= 20) throw bad('That message has enough reactions');
      q('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(m.id, req.user.id, emoji, now());
    }
    const msg = one(m.id);
    sendTo(audience(c), { type: 'message-updated', message: msg });
    res.json(msg);
  });

  // A file attached to a message, for the people in the conversation.
  r.get('/messages/:id/files/:fileId', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    loadChannel(m.channel_id, req.user);
    const listed = JSON.parse(m.files || '[]').some((f) => f.id === req.params.fileId);
    const f = listed && q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(req.params.fileId);
    if (!f) throw notFound('That file is no longer there');
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.mime || '') && req.query.download === undefined;
    res.setHeader('Content-Type', inline ? f.mime : (f.mime || 'application/octet-stream'));
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    res.sendFile(path.join(FILES_DIR, f.storage), { headers: { 'Cache-Control': 'private, max-age=3600' } });
  });

  // The Drive folder files you attach from your computer go to ("Chat files", made when first needed).
  r.post('/files-folder', (req, res) => {
    const found = q("SELECT id FROM files WHERE owner_id = ? AND parent_id IS NULL AND kind = 'folder' AND name = 'Chat files' AND trashed = 0").get(req.user.id);
    res.json({ id: found ? found.id : insertFile({ owner: req.user.id, parentId: null, name: 'Chat files', kind: 'folder' }) });
  });

  r.delete('/messages/:id', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    const moderator = req.user.is_admin && !c.dm_key; // company admins moderate their own channels
    if (m.user_id !== req.user.id && !moderator) throw notFound();
    q('DELETE FROM messages WHERE id = ? OR parent_id = ?').run(m.id, m.id); // a thread goes with its message
    sendTo(audience(c), { type: 'message-deleted', id: m.id, channel_id: m.channel_id, parent_id: m.parent_id });
    if (m.parent_id) { const p = one(m.parent_id); if (p) sendTo(audience(c), { type: 'message-updated', message: p }); }
    res.json({ ok: true });
  });

  return r;
}
