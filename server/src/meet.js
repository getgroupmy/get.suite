// Meet: video meetings in the browser. Audio and video go straight between the people in a meeting
// (WebRTC, each to each, so up to MAX_PEOPLE); this server only introduces them over a WebSocket
// (/ws/meet/<code>) and passes on what they say to each other: connection offers and answers, network
// candidates, mute/camera/hand state, and the meeting's chat. Mounted at /api/meet for the REST side.
import { Router } from 'express';
import { insertFile } from './routes/files.js';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { q } from './db.js';
import { now, str, notFound, forbidden } from './util.js';

q(`CREATE TABLE IF NOT EXISTS meetings (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS meeting_visits (
  code TEXT NOT NULL REFERENCES meetings(code) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
)`).run();

// Attendance: each time someone is in a meeting (from joining to leaving; left_at null while there).
q(`CREATE TABLE IF NOT EXISTS meeting_attendance (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES meetings(code) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  joined_at INTEGER NOT NULL,
  left_at INTEGER
)`).run();
q('CREATE INDEX IF NOT EXISTS meeting_attendance_code ON meeting_attendance(code, joined_at)').run();
// After a restart nobody is in a meeting any more.
q('UPDATE meeting_attendance SET left_at = joined_at WHERE left_at IS NULL').run();

/**
 * Who came to a meeting: one row per person (first joined, last left, total time there, how many
 * times they joined), earliest first. Times still running count up to `at`.
 */
export function attendanceOf(code, at = Date.now()) {
  const byPerson = new Map();
  for (const v of q('SELECT * FROM meeting_attendance WHERE code = ? ORDER BY joined_at').all(code)) {
    const key = v.user_id || v.email || v.name;
    const p = byPerson.get(key) || { name: v.name, email: v.email, first: v.joined_at, last: null, ms: 0, times: 0, here: false };
    p.times++;
    p.ms += (v.left_at ?? at) - v.joined_at;
    if (v.left_at === null) p.here = true;
    p.last = p.here ? null : Math.max(p.last ?? 0, v.left_at);
    byPerson.set(key, p);
  }
  return [...byPerson.values()];
}
const minutes = (ms) => Math.max(0, Math.round(ms / 6e4));

export const MAX_PEOPLE = 8;
const LETTERS = 'abcdefghijkmnopqrstuvwxyz'; // no l: it looks like 1 and I

/** A code people can read out: "abc-defg-hij". */
export function newCode() {
  const pick = (n) => Array.from(crypto.randomBytes(n), (b) => LETTERS[b % LETTERS.length]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}
export const validCode = (c) => /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(String(c || ''));
/** The meeting with this code, if this person may use it (e.g. to put it on an event), else null. */
export function meetingFor(code, user) {
  const m = validCode(code) && q('SELECT * FROM meetings WHERE code = ?').get(code);
  return m && mayJoin(m, user) ? m : null;
}

/** Extra servers that help calls cross the internet (STUN/TURN), from MEET_ICE_SERVERS (JSON list). */
export function iceServers(env = process.env.MEET_ICE_SERVERS) {
  if (!env) return [];
  try {
    const list = JSON.parse(env);
    return Array.isArray(list) ? list.filter((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls))) : [];
  } catch { return []; }
}

/** Can this person join a meeting from this company? Their own company, or one both sides work with. */
export function mayJoin(meeting, user) {
  if (meeting.org_id === user.org_id) return true;
  return q('SELECT MIN(allow_external) AS ok FROM orgs WHERE id IN (?, ?)').get(meeting.org_id, user.org_id)?.ok === 1;
}

// Who is in each meeting right now: code -> Map(peerId -> { ws, user, state }).
const rooms = new Map();
const describe = (id, p) => ({ id, user: { id: p.user.id, name: p.user.name, email: p.user.email }, state: p.state });
export const peopleIn = (code) => [...(rooms.get(code)?.entries() ?? [])].map(([id, p]) => describe(id, p));

function cleanState(s = {}) {
  return { mic: s.mic !== false, cam: s.cam !== false, hand: !!s.hand, screen: !!s.screen, rec: !!s.rec }; // rec: they're recording the meeting (everyone is shown)
}

export function meetRoutes() {
  const r = Router();
  r.get('/', (req, res) => {
    res.json(q(`SELECT m.code, m.title, m.created_at, m.last_used, u.name AS created_by_name FROM meetings m
                LEFT JOIN users u ON u.id = m.created_by
                WHERE m.created_by = ? OR m.code IN (SELECT code FROM meeting_visits WHERE user_id = ?)
                ORDER BY m.last_used DESC LIMIT 20`).all(req.user.id, req.user.id)
      .map((m) => ({ ...m, people: peopleIn(m.code).length })));
  });
  r.post('/', (req, res) => {
    const title = str(req.body?.title ?? '', { max: 200 }) || '';
    let code;
    do code = newCode(); while (q('SELECT 1 FROM meetings WHERE code = ?').get(code));
    const t = now();
    q('INSERT INTO meetings (code, org_id, created_by, title, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?)').run(code, req.user.org_id, req.user.id, title, t, t);
    res.status(201).json({ code, title });
  });
  // Who came: for whoever started it, or anyone who was in it. ?format=csv to download.
  r.get('/:code/attendance', (req, res) => {
    const m = validCode(req.params.code) && q('SELECT * FROM meetings WHERE code = ?').get(req.params.code);
    if (!m || (m.created_by !== req.user.id && !q('SELECT 1 FROM meeting_attendance WHERE code = ? AND user_id = ?').get(m.code, req.user.id))) throw notFound();
    const people = attendanceOf(m.code);
    if (req.query.format === 'csv') {
      const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
      const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) : '');
      const rows = [['Name', 'Email', 'First joined (UTC)', 'Last left (UTC)', 'Minutes', 'Times joined'],
        ...people.map((p) => [p.name, p.email, iso(p.first), p.here ? 'still there' : iso(p.last), minutes(p.ms), p.times])];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="attendance-${m.code}.csv"`);
      return res.send(`\ufeff${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`);
    }
    res.json({ code: m.code, title: m.title, people: people.map((p) => ({ ...p, minutes: minutes(p.ms) })) });
  });
  // Recordings are saved in a "Meet recordings" folder in the recorder's Drive (made when first needed).
  r.post('/recordings-folder', (req, res) => {
    const found = q("SELECT id FROM files WHERE owner_id = ? AND parent_id IS NULL AND kind = 'folder' AND name = 'Meet recordings' AND trashed = 0").get(req.user.id);
    res.json({ id: found ? found.id : insertFile({ owner: req.user.id, parentId: null, name: 'Meet recordings', kind: 'folder' }) });
  });
  r.get('/:code', (req, res) => {
    const m = validCode(req.params.code) && q('SELECT * FROM meetings WHERE code = ?').get(req.params.code);
    if (!m) throw notFound('No meeting has that code. Check it and try again.');
    if (!mayJoin(m, req.user)) throw forbidden('This meeting belongs to another company');
    res.json({ code: m.code, title: m.title, people: peopleIn(m.code), max: MAX_PEOPLE, ice_servers: iceServers() });
  });
  return r;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

/** /ws/meet/<code>: join the meeting's room. */
export function handleMeetUpgrade(req, socket, head, user) {
  const code = decodeURIComponent(req.url.split('?')[0].split('/')[3] || '');
  const m = validCode(code) && q('SELECT * FROM meetings WHERE code = ?').get(code);
  if (!m || !mayJoin(m, user)) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let room = rooms.get(code);
    if (room && room.size >= MAX_PEOPLE) { ws.close(4001, 'This meeting is full'); return; }
    if (!room) rooms.set(code, (room = new Map()));
    const id = crypto.randomBytes(8).toString('hex');
    const asked = new URL(req.url, 'http://x').searchParams; // how they come in: ?mic=0&cam=0
    const me = { ws, user, state: cleanState({ mic: asked.get('mic') !== '0', cam: asked.get('cam') !== '0' }) };
    const toOthers = (payload) => { const d = JSON.stringify(payload); for (const [pid, p] of room) if (pid !== id && p.ws.readyState === 1) p.ws.send(d); };
    const toAll = (payload) => { const d = JSON.stringify(payload); for (const p of room.values()) if (p.ws.readyState === 1) p.ws.send(d); };
    ws.send(JSON.stringify({ type: 'welcome', id, peers: peopleIn(code) }));
    room.set(id, me);
    toOthers({ type: 'joined', peer: describe(id, me) });
    const t = now();
    q('UPDATE meetings SET last_used = ? WHERE code = ?').run(t, code);
    q('INSERT INTO meeting_visits (code, user_id, at) VALUES (?, ?, ?) ON CONFLICT (code, user_id) DO UPDATE SET at = excluded.at').run(code, user.id, t);
    q('INSERT INTO meeting_attendance (id, code, user_id, name, email, joined_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, code, user.id, user.name, user.email || user.username, t);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type === 'signal') {
        const to = room.get(String(msg.to));
        if (to && to.ws.readyState === 1) to.ws.send(JSON.stringify({ type: 'signal', from: id, data: msg.data }));
      } else if (msg?.type === 'state') {
        me.state = cleanState({ ...me.state, ...msg.state });
        toAll({ type: 'state', id, state: me.state });
      } else if (msg?.type === 'chat') {
        const text = String(msg.text ?? '').trim().slice(0, 2000);
        if (text) toAll({ type: 'chat', id, name: user.name, text, at: now() });
      } else if (msg?.type === 'react') {
        const emoji = ['👍', '❤️', '😂', '😮', '👏', '🎉'].includes(msg.emoji) ? msg.emoji : null;
        if (emoji) toAll({ type: 'react', id, emoji });
      }
    });
    ws.on('close', () => {
      q('UPDATE meeting_attendance SET left_at = ? WHERE id = ? AND left_at IS NULL').run(now(), id);
      room.delete(id);
      if (!room.size) rooms.delete(code);
      toOthers({ type: 'left', id });
    });
  });
}
