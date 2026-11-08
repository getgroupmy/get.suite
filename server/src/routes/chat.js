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
const MAX_FILES = 10, MAX_PINS = 50;
// Muted conversations: no unread count in the app bar (mentions still count), for each person.
q(`CREATE TABLE IF NOT EXISTS chat_mutes (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
)`).run();
// Pinned messages: kept at hand for everyone in the conversation.
for (const [col, type] of [['pinned_at', 'INTEGER'], ['pinned_by', 'TEXT']]) {
  if (!q('PRAGMA table_info(messages)').all().some((c) => c.name === col)) q(`ALTER TABLE messages ADD COLUMN ${col} ${type}`).run();
}
// Polls: a message can carry a question with options ({ question, options: [{ id, text }], multi, closed_at }); votes are kept per person.
if (!q('PRAGMA table_info(messages)').all().some((c) => c.name === 'poll')) q('ALTER TABLE messages ADD COLUMN poll TEXT').run();
q(`CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option_id)
)`).run();
const MAX_OPTIONS = 10;
// Forwarded messages: a copy of another message (who wrote it, where, when, its text), below an optional note.
if (!q('PRAGMA table_info(messages)').all().some((c) => c.name === 'forwarded')) q('ALTER TABLE messages ADD COLUMN forwarded TEXT').run();

/** A poll as sent with a new message, checked: 2–10 different options, a question. */
export function cleanPoll(p) {
  if (!p || typeof p !== 'object') throw bad('A poll needs a question and options');
  const question = str(p.question, { required: true, name: 'Question', max: 300 });
  const texts = (Array.isArray(p.options) ? p.options : []).map((o) => String(o ?? '').trim()).filter(Boolean);
  if (texts.some((t) => t.length > 200)) throw bad('An option is too long');
  if (new Set(texts.map((t) => t.toLowerCase())).size !== texts.length) throw bad('Two options are the same');
  if (texts.length < 2) throw bad('A poll needs at least two options');
  if (texts.length > MAX_OPTIONS) throw bad(`At most ${MAX_OPTIONS} options`);
  return { question, options: texts.map((text, i) => ({ id: `o${i + 1}`, text })), multi: !!p.multi };
}
import { sendTo, onlineUserIds } from '../hub.js';
import { canReach, orgMemberIds } from '../tenancy.js';
import { groupSlug } from '../groups.js';

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
/** Announcement channels: may this person start a conversation (not reply in a thread) here? */
const postersOf = (c) => (c.posters ? JSON.parse(c.posters) : null);
const mayPost = (c, user, parent) => !!parent || !postersOf(c) || canManage(c, user) || postersOf(c).includes(user.id);

/** For a DM: may this user still write to it? (the other person may be in a company that closed external access) */
function dmOpen(c, user) {
  return membersOf(c).every((id) => id === user.id || canReach(user, id));
}

// Each message with its thread: how many replies, when the last came, and who replied (first few).
const MSG = `SELECT m.id, m.channel_id, m.user_id, m.body, m.created_at, m.edited_at, m.files, m.parent_id, m.pinned_at, m.poll, m.forwarded, u.name AS user_name, (SELECT pu.name FROM users pu WHERE pu.id = m.pinned_by) AS pinned_by_name,
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
  const withPolls = rows.filter((m) => m.poll).map((m) => m.id);
  const votes = withPolls.length ? q(`SELECT v.message_id, v.option_id, v.user_id, u.name FROM poll_votes v LEFT JOIN users u ON u.id = v.user_id
                       WHERE v.message_id IN (SELECT value FROM json_each(?)) ORDER BY v.created_at`).all(JSON.stringify(withPolls)) : [];
  return rows.map((m) => {
    const mine = reactions.filter((r) => r.message_id === m.id);
    let poll = null;
    if (m.poll) {
      const p = JSON.parse(m.poll), mv = votes.filter((v) => v.message_id === m.id);
      poll = { ...p, voters: new Set(mv.map((v) => v.user_id)).size,
        options: p.options.map((o) => ({ ...o, votes: mv.filter((v) => v.option_id === o.id).map((v) => ({ id: v.user_id, name: v.name || 'Someone' })) })) };
    }
    const byEmoji = [];
    for (const r of mine) {
      let e = byEmoji.find((x) => x.emoji === r.emoji);
      if (!e) byEmoji.push(e = { emoji: r.emoji, users: [] });
      e.users.push({ id: r.user_id, name: r.name || 'Someone' });
    }
    return { ...m, files: m.files ? JSON.parse(m.files) : [], reactions: byEmoji, repliers: m.repliers ? JSON.parse(m.repliers) : [], poll, forwarded: m.forwarded ? JSON.parse(m.forwarded) : null };
  });
}
const one = (id) => shape([q(`${MSG} WHERE m.id = ?`).get(id)].filter(Boolean))[0];

/** The conversation, if this person may write in it now. */
function writable(channelId, user) {
  const c = loadChannel(channelId, user);
  if (c.dm_key && !dmOpen(c, user)) throw bad('External messaging is turned off for one of the companies');
  readOnly(c);
  return c;
}

/** A message as sent (checked): { body, files, poll, parent }. */
function readMessage(c, user, input) {
  // Files from Drive the sender can open; everyone in the conversation can then open them from it.
  const ids = Array.isArray(input.files) ? [...new Set(input.files.map(String))] : [];
  if (ids.length > MAX_FILES) throw bad(`At most ${MAX_FILES} files per message`);
  const files = ids.map((fid) => {
    const f = q("SELECT id, name, mime, size, kind FROM files WHERE id = ? AND trashed = 0").get(fid);
    if (!f || f.kind !== 'file' || !roleFor(f.id, user.id)) throw bad('A file is not available');
    return { id: f.id, name: f.name, mime: f.mime || 'application/octet-stream', size: f.size };
  });
  const poll = input.poll ? cleanPoll(input.poll) : null;
  const body = poll ? poll.question : str(input.body, { required: !files.length, name: 'Message', max: 8000 }) || '';
  // A reply goes in the thread of a message in this conversation (threads don't nest).
  let parent = null;
  if (input.parent_id) {
    parent = q('SELECT id, parent_id, channel_id FROM messages WHERE id = ?').get(String(input.parent_id));
    if (!parent || parent.channel_id !== c.id) throw bad('That message is gone');
    if (parent.parent_id) parent = { id: parent.parent_id };
  }
  return { body, files, poll, parent };
}

/** Post a message: saved, shown to everyone in the conversation, mentions told. */
function deliver(c, user, { body, files, poll, parent, forwarded = null }) {
  if (!mayPost(c, user, parent)) throw new HttpError(403, 'Only some people post in this channel; you can reply in threads');
  const id = uid();
  q('INSERT INTO messages (id, channel_id, user_id, body, created_at, files, parent_id, poll, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, c.id, user.id, body, now(), files.length ? JSON.stringify(files) : null, parent?.id ?? null, poll ? JSON.stringify(poll) : null, forwarded ? JSON.stringify(forwarded) : null);
  q('INSERT INTO channel_reads (channel_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET read_at = excluded.read_at').run(c.id, user.id, now());
  const msg = one(id);
  sendTo(audience(c), { type: 'message', message: msg });
  notifyMentions(c, user, msg);
  if (parent) sendTo(audience(c), { type: 'message-updated', message: one(parent.id) }); // its reply count
  return msg;
}

// Scheduled messages: sent by the server at their time, checked again then (the sender may have left,
// the channel been archived, a file been deleted). One that can't go is kept with the reason, and the
// sender is told.
q(`CREATE TABLE IF NOT EXISTS chat_scheduled (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  files TEXT,
  parent_id TEXT,
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  error TEXT
)`).run();
q('CREATE INDEX IF NOT EXISTS chat_scheduled_due ON chat_scheduled(send_at)').run();

function sendScheduled(row, now_ = false) {
  const user = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(row.user_id);
  try {
    if (!user) throw bad('Your account is turned off');
    const c = writable(row.channel_id, user);
    const files = row.files ? JSON.parse(row.files).map((f) => f.id) : [];
    const msg = deliver(c, user, readMessage(c, user, { body: row.body, files, parent_id: row.parent_id }));
    q('DELETE FROM chat_scheduled WHERE id = ?').run(row.id);
    sendTo([user.id], { type: 'chat-scheduled', channel_id: row.channel_id });
    return msg;
  } catch (e) {
    if (now_ || !user) throw e;
    q('UPDATE chat_scheduled SET error = ?, send_at = ? WHERE id = ?').run(e.message, 8.64e15, row.id); // kept, not retried
    notify([user.id], { kind: 'chat', title: 'A scheduled message couldn’t be sent', body: `${e.message}: “${row.body.slice(0, 80)}”`, link: `/chat/${row.channel_id}`, actor: null });
    sendTo([user.id], { type: 'chat-scheduled', channel_id: row.channel_id });
    return null;
  }
}

// "Remind me about this": a notification at the chosen time, linking back to the message.
// Saved messages: a person's own bookmarks, to come back to (from any conversation they're in).
q(`CREATE TABLE IF NOT EXISTS chat_saved (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
)`).run();
const MAX_SAVED = 1000;

q(`CREATE TABLE IF NOT EXISTS chat_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  UNIQUE (user_id, message_id)
)`).run();

function remindDue(at) {
  const due = q(`SELECT r.*, m.body, m.channel_id, m.parent_id, u.name AS author, c.name AS channel, c.dm_key
                 FROM chat_reminders r JOIN messages m ON m.id = r.message_id JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id
                 WHERE r.at <= ? ORDER BY r.at LIMIT 100`).all(at);
  for (const r of due) {
    q('DELETE FROM chat_reminders WHERE id = ?').run(r.id);
    const user = q('SELECT * FROM users WHERE id = ? AND disabled = 0').get(r.user_id);
    let ok = false;
    try { ok = !!(user && loadChannel(r.channel_id, user)); } catch { ok = false; } // left the channel since: no reminder
    if (!ok) continue;
    notify([r.user_id], { kind: 'chat', title: `Reminder: ${r.author || 'a message'}${r.dm_key ? '' : ` in #${r.channel}`}`, body: String(r.body || '📎 a file').slice(0, 200),
      link: `/chat/${r.channel_id}?msg=${r.parent_id || r.message_id}${r.parent_id ? `&thread=${r.parent_id}` : ''}`, actor: null });
    sendTo([r.user_id], { type: 'chat-reminders' });
  }
  return due.length;
}

/** Send what's due, and remind about what's due (every few seconds; started with the server). */
export function sendDueChat(at = Date.now()) {
  const due = q('SELECT * FROM chat_scheduled WHERE send_at <= ? AND error IS NULL ORDER BY send_at LIMIT 100').all(at);
  for (const row of due) sendScheduled(row);
  remindDue(at);
  return due.length;
}
export function startChatScheduler() { setInterval(() => { try { sendDueChat(); } catch (e) { console.error('[chat] scheduled:', e.message); } }, 10e3).unref(); }

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
// @a-group (one of the company's groups, by its name with dashes) and @channel (everyone in the conversation).
const GROUP_MENTION_RE = /(?<![\w@.+-])@([a-z0-9][a-z0-9-]{0,79})(?![\w@.-])/gi;
function notifyMentions(c, from, msg) {
  const body = String(msg.body);
  const names = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()))].slice(0, 50);
  const words = [...new Set([...body.matchAll(GROUP_MENTION_RE)].map((m) => m[1].toLowerCase()))].slice(0, 20);
  if (!names.length && !words.length) return;
  const inIt = new Set(audience(c));
  const people = new Set(q(`SELECT id FROM users WHERE LOWER(username) IN (SELECT value FROM json_each(?)) AND disabled = 0`).all(JSON.stringify(names)).map((u) => u.id));
  if (words.length && !c.dm_key) {
    if (words.includes('channel')) for (const id of inIt) people.add(id);
    const org = c.org_id || from.org_id;
    for (const g of q('SELECT id, name FROM groups WHERE org_id = ?').all(org)) {
      if (!words.includes(groupSlug(g.name))) continue;
      for (const m of q('SELECT user_id FROM group_members WHERE group_id = ?').all(g.id)) people.add(m.user_id);
    }
  }
  const ids = [...people].filter((id) => id !== from.id && inIt.has(id)); // only people in the conversation
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
    const rows = q(`SELECT c.id, c.name, c.dm_key, c.private, c.topic, c.archived_at, c.created_by, c.posters,
                      (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = c.id) AS member_count,
                      EXISTS (SELECT 1 FROM chat_mutes mu WHERE mu.channel_id = c.id AND mu.user_id = ?) AS muted,
                      (SELECT MAX(created_at) FROM messages m WHERE m.channel_id = c.id) AS last_at,
                      (SELECT u.name FROM channel_members cm JOIN users u ON u.id = cm.user_id
                        WHERE cm.channel_id = c.id AND cm.user_id != ? LIMIT 1) AS dm_name,
                      (SELECT u.id FROM channel_members cm JOIN users u ON u.id = cm.user_id
                        WHERE cm.channel_id = c.id AND cm.user_id != ? LIMIT 1) AS dm_user_id,
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
                    ORDER BY c.dm_key IS NOT NULL, c.archived_at IS NOT NULL, c.name`).all(me, me, me, me, req.user.org_id, me, me, me, me, me, `@${req.user.username}`, req.user.org_id, me);
    res.json({ channels: rows.map((c) => ({ ...c, muted: !!c.muted, posters: postersOf(c), can_post: mayPost(c, req.user, null) })), online: onlineUserIds() });
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
    // Who can post: { posters: null } (everyone) or { posters: [user ids] } (just them, plus whoever made it and admins).
    if (b.posters !== undefined) {
      if (!canManage(c, req.user)) throw new HttpError(403, 'Only whoever made the channel, or an admin, can change that');
      if (b.posters === null) set.posters = null;
      else {
        if (!Array.isArray(b.posters)) throw bad('posters must be a list or null');
        const ids = [...new Set(b.posters.map(String))].slice(0, 200);
        for (const id of ids) { const u = q('SELECT org_id FROM users WHERE id = ?').get(id); if (!u || u.org_id !== c.org_id) throw bad('Posters must be in the company'); }
        set.posters = JSON.stringify(ids);
      }
    }
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

  // Forward a message you can see to another conversation you can write in, with a note of your own if you like.
  // Its files go with it (everyone there can open them from the message). Forwarding a forward passes on the original.
  r.post('/messages/:id/forward', (req, res) => {
    const src = q('SELECT m.*, u.name AS author FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?').get(req.params.id);
    if (!src) throw notFound('Message not found');
    const from = loadChannel(src.channel_id, req.user);
    if (src.poll) throw bad('Polls can’t be forwarded');
    const c = writable(String(req.body.channel_id || ''), req.user);
    const note = str(req.body.body, { max: 8000, name: 'Message' }) || '';
    const earlier = src.forwarded && !src.body ? JSON.parse(src.forwarded) : null;
    // A channel's name is shown; a direct message or private channel's isn't.
    const forwarded = earlier || { name: src.author || 'Deleted user', where: from.dm_key || from.private ? null : from.name, at: src.created_at, body: src.body || '' };
    const files = src.files ? JSON.parse(src.files) : [];
    res.status(201).json(deliver(c, req.user, { body: note, files, poll: null, parent: null, forwarded }));
  });

  r.post('/channels/:id/messages', (req, res) => {
    const c = writable(req.params.id, req.user);
    res.status(201).json(deliver(c, req.user, readMessage(c, req.user, req.body)));
  });

  // ---- scheduled messages: written now, sent at a chosen time (as if typed then) ----
  const MAX_SCHEDULED = 50;
  const shapeScheduled = (row) => ({ id: row.id, channel_id: row.channel_id, body: row.body, files: row.files ? JSON.parse(row.files) : [], parent_id: row.parent_id, send_at: row.send_at, error: row.error || null });
  r.post('/channels/:id/scheduled', (req, res) => {
    const c = writable(req.params.id, req.user);
    const m = readMessage(c, req.user, req.body);
    if (m.poll) throw bad('Polls can’t be scheduled');
    if (!mayPost(c, req.user, m.parent)) throw new HttpError(403, 'Only some people post in this channel; you can reply in threads');
    const at = Number(req.body.send_at);
    if (!Number.isFinite(at) || at < Date.now() + 30e3) throw bad('Choose a time at least a minute from now');
    if (at > Date.now() + 366 * 864e5) throw bad('Choose a time within a year');
    if (q('SELECT COUNT(*) AS n FROM chat_scheduled WHERE user_id = ?').get(req.user.id).n >= MAX_SCHEDULED) throw bad(`At most ${MAX_SCHEDULED} scheduled messages`);
    const id = uid();
    q('INSERT INTO chat_scheduled (id, channel_id, user_id, body, files, parent_id, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.id, req.user.id, m.body, m.files.length ? JSON.stringify(m.files) : null, m.parent?.id ?? null, Math.round(at), now());
    sendTo([req.user.id], { type: 'chat-scheduled', channel_id: c.id });
    res.status(201).json(shapeScheduled(q('SELECT * FROM chat_scheduled WHERE id = ?').get(id)));
  });
  // Your scheduled messages in a conversation (or, without one, everywhere), soonest first.
  r.get('/scheduled', (req, res) => {
    const rows = req.query.channel ? q('SELECT * FROM chat_scheduled WHERE user_id = ? AND channel_id = ? ORDER BY send_at').all(req.user.id, String(req.query.channel))
      : q('SELECT * FROM chat_scheduled WHERE user_id = ? ORDER BY send_at').all(req.user.id);
    res.json(rows.map(shapeScheduled));
  });
  const ownScheduled = (req) => { const row = q('SELECT * FROM chat_scheduled WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id); if (!row) throw notFound(); return row; };
  r.patch('/scheduled/:id', (req, res) => {
    const row = ownScheduled(req);
    const at = req.body.send_at !== undefined ? Number(req.body.send_at) : row.send_at;
    if (!Number.isFinite(at) || at < Date.now() + 30e3 || at > Date.now() + 366 * 864e5) throw bad('Choose a time from a minute to a year from now');
    const body = req.body.body !== undefined ? str(req.body.body, { required: !row.files, name: 'Message', max: 8000 }) || '' : row.body;
    q('UPDATE chat_scheduled SET send_at = ?, body = ?, error = NULL WHERE id = ?').run(Math.round(at), body, row.id);
    sendTo([req.user.id], { type: 'chat-scheduled', channel_id: row.channel_id });
    res.json(shapeScheduled(q('SELECT * FROM chat_scheduled WHERE id = ?').get(row.id)));
  });
  r.delete('/scheduled/:id', (req, res) => {
    const row = ownScheduled(req);
    q('DELETE FROM chat_scheduled WHERE id = ?').run(row.id);
    sendTo([req.user.id], { type: 'chat-scheduled', channel_id: row.channel_id });
    res.json({ ok: true });
  });
  r.post('/scheduled/:id/send', (req, res) => {
    const row = ownScheduled(req);
    res.json(sendScheduled(row, true));
  });

  // Mute a conversation for yourself (or unmute it).
  r.post('/channels/:id/mute', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    if (req.body.muted === false) q('DELETE FROM chat_mutes WHERE channel_id = ? AND user_id = ?').run(c.id, req.user.id);
    else q('INSERT OR IGNORE INTO chat_mutes (channel_id, user_id) VALUES (?, ?)').run(c.id, req.user.id);
    sendTo([req.user.id], { type: 'channels-changed' });
    res.json({ muted: req.body.muted !== false });
  });

  // Read up to now: unread counts go back to zero (on your other devices too).
  r.post('/channels/:id/read', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    q('INSERT INTO channel_reads (channel_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)').run(c.id, req.user.id, now());
    sendTo([req.user.id], { type: 'chat-read', channel_id: c.id });
    res.json({ ok: true });
  });

  // Who in a conversation can't open a Drive file (a link just sent there), so it can be shared with them.
  // Only for someone who can open it; can_share says whether they own it.
  r.get('/channels/:id/missing-access', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    const f = q('SELECT id, owner_id FROM files WHERE id = ? AND trashed = 0').get(String(req.query.file || ''));
    if (!f || !roleFor(f.id, req.user.id)) throw notFound('File not found');
    const ids = audience(c).filter((u) => u !== req.user.id && !roleFor(f.id, u));
    const people = ids.length ? q(`SELECT id, name FROM users WHERE disabled = 0 AND id IN (SELECT value FROM json_each(?)) ORDER BY name`).all(JSON.stringify(ids)) : [];
    res.json({ people: people.slice(0, 20), total: people.length, everyone: !c.dm_key && !c.private, can_share: f.owner_id === req.user.id });
  });

  // Mark unread from a message: the conversation counts as read only up to just before it.
  r.post('/messages/:id/unread', (req, res) => {
    const m = q('SELECT id, channel_id, created_at FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound('Message not found');
    const c = loadChannel(m.channel_id, req.user);
    q('INSERT INTO channel_reads (channel_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET read_at = excluded.read_at').run(c.id, req.user.id, m.created_at - 1);
    sendTo([req.user.id], { type: 'chat-unread', channel_id: c.id });
    res.json({ ok: true });
  });

  // Change your own message.
  r.patch('/messages/:id', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    if (m.user_id !== req.user.id) throw notFound();
    readOnly(c);
    if (m.poll) throw bad("A poll can't be edited");
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

  // Vote in a poll: `options` is your whole choice (one id, or several in a poll that allows it; [] takes your vote back).
  r.post('/messages/:id/vote', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m?.poll) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    readOnly(c);
    const p = JSON.parse(m.poll);
    if (p.closed_at) throw bad('This poll is closed');
    const picked = [...new Set((Array.isArray(req.body.options) ? req.body.options : []).map(String))];
    if (picked.some((o) => !p.options.some((x) => x.id === o))) throw bad('That option is not in the poll');
    if (!p.multi && picked.length > 1) throw bad('Choose one option');
    tx(() => {
      q('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(m.id, req.user.id);
      for (const o of picked) q('INSERT INTO poll_votes (message_id, user_id, option_id, created_at) VALUES (?, ?, ?, ?)').run(m.id, req.user.id, o, now());
    });
    const msg = one(m.id);
    sendTo(audience(c), { type: 'message-updated', message: msg });
    res.json(msg);
  });

  // Close a poll (or open it again): only who asked.
  r.post('/messages/:id/poll/close', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m?.poll) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    if (m.user_id !== req.user.id) throw bad('Only who asked can close the poll');
    readOnly(c);
    const p = JSON.parse(m.poll);
    const closed = req.body.closed !== false;
    q('UPDATE messages SET poll = ? WHERE id = ?').run(JSON.stringify({ ...p, closed_at: closed ? now() : null }), m.id);
    const msg = one(m.id);
    sendTo(audience(c), { type: 'message-updated', message: msg });
    res.json(msg);
  });

  // Remind me about a message: { at } (or { at: null } to cancel). Only you see it.
  r.post('/messages/:id/remind', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    loadChannel(m.channel_id, req.user);
    if (req.body.at === null) {
      q('DELETE FROM chat_reminders WHERE user_id = ? AND message_id = ?').run(req.user.id, m.id);
    } else {
      const at = Number(req.body.at);
      if (!Number.isFinite(at) || at < Date.now() + 30e3 || at > Date.now() + 366 * 864e5) throw bad('Choose a time from a minute to a year from now');
      if (q('SELECT COUNT(*) AS n FROM chat_reminders WHERE user_id = ?').get(req.user.id).n >= 200) throw bad('You have enough reminders already');
      q(`INSERT INTO chat_reminders (id, user_id, message_id, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, message_id) DO UPDATE SET at = excluded.at`).run(uid(), req.user.id, m.id, Math.round(at));
    }
    sendTo([req.user.id], { type: 'chat-reminders' });
    res.json({ ok: true });
  });
  // Save a message for later (or stop): only messages you can see.
  r.put('/messages/:id/saved', (req, res) => {
    const m = q('SELECT id, channel_id FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound('Message not found');
    loadChannel(m.channel_id, req.user);
    if (req.body.saved) {
      if (q('SELECT COUNT(*) AS n FROM chat_saved WHERE user_id = ?').get(req.user.id).n >= MAX_SAVED) throw bad(`You can keep up to ${MAX_SAVED} saved messages`);
      q('INSERT OR IGNORE INTO chat_saved (user_id, message_id, saved_at) VALUES (?, ?, ?)').run(req.user.id, m.id, now());
    } else q('DELETE FROM chat_saved WHERE user_id = ? AND message_id = ?').run(req.user.id, m.id);
    sendTo([req.user.id], { type: 'chat-saved' });
    res.json({ saved: !!req.body.saved });
  });
  // Your saved messages, last saved first (ones in conversations you've left since are left out).
  r.get('/saved', (req, res) => {
    const rows = q(`SELECT s.message_id, s.saved_at, m.body, m.channel_id, m.parent_id, m.created_at, m.files, u.name AS author, c.name AS channel, c.dm_key
                    FROM chat_saved s JOIN messages m ON m.id = s.message_id JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id
                    WHERE s.user_id = ? ORDER BY s.saved_at DESC`).all(req.user.id);
    res.json(rows.filter((r) => { try { return !!loadChannel(r.channel_id, req.user); } catch { return false; } })
      .map(({ dm_key, files, ...x }) => ({ ...x, dm: !!dm_key, files: files ? JSON.parse(files).length : 0 })));
  });

  // Your reminders, soonest first.
  r.get('/reminders', (req, res) => {
    res.json(q(`SELECT r.message_id, r.at, m.body, m.channel_id, m.parent_id, u.name AS author, c.name AS channel, c.dm_key
                FROM chat_reminders r JOIN messages m ON m.id = r.message_id JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id
                WHERE r.user_id = ? ORDER BY r.at`).all(req.user.id).map(({ dm_key, ...x }) => ({ ...x, dm: !!dm_key })));
  });

  // Pin a message to its conversation (or unpin it). Anyone in the conversation may; threads' replies can't be.
  r.post('/messages/:id/pin', (req, res) => {
    const m = q('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!m) throw notFound();
    const c = loadChannel(m.channel_id, req.user);
    readOnly(c);
    if (m.parent_id) throw bad('Replies in a thread can’t be pinned');
    const pin = req.body.pinned !== false;
    if (pin && !m.pinned_at) {
      if (q('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL').get(c.id).n >= MAX_PINS) throw bad(`At most ${MAX_PINS} pinned messages; unpin one first`);
      q('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(now(), req.user.id, m.id);
    } else if (!pin) q('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(m.id);
    const msg = one(m.id);
    sendTo(audience(c), { type: 'message-updated', message: msg });
    sendTo(audience(c), { type: 'pins-changed', channel_id: c.id });
    res.json(msg);
  });

  // A conversation's pinned messages, most recently pinned first.
  r.get('/channels/:id/pins', (req, res) => {
    const c = loadChannel(req.params.id, req.user);
    res.json(shape(q(`${MSG} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC LIMIT ${MAX_PINS}`).all(c.id)));
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
