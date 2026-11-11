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
import { makeBoard } from './meetboard.js';
import { nextState } from './meethands.js';
import { notify } from './notifications.js';

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
/** Everyone in a meeting, in the main room or a breakout room. */
const everyoneIn = (code) => roomsOf(code).flatMap((k) => peopleIn(k));
/** Who's in a meeting now (every room): their names, for showing a live call elsewhere (Chat). */
export const namesIn = (code) => everyoneIn(code).map((p) => p.user.name);
/** The ids of the signed-in people in a meeting now (every room). */
export const userIdsIn = (code) => everyoneIn(code).map((p) => p.user.id);

const cleanState = (s = {}) => nextState({}, s);

/** /api/public/meet/<code>: what a guest without an account sees before asking to join. */
export function publicMeetRoutes() {
  const r = Router();
  r.get('/:code', (req, res) => {
    const m = validCode(req.params.code) && q('SELECT m.*, o.name AS org_name FROM meetings m JOIN orgs o ON o.id = m.org_id WHERE m.code = ?').get(req.params.code);
    if (!m || !guestsAllowed(m.org_id)) throw notFound('No meeting has that code, or it doesn’t take guests. Ask whoever invited you for the link again.');
    res.json({ code: m.code, title: m.title, company: m.org_name, people: everyoneIn(m.code).map((p) => ({ user: { name: p.user.name } })), max: MAX_PEOPLE, ice_servers: iceServers() });
  });
  return r;
}

export function meetRoutes() {
  const r = Router();
  r.get('/', (req, res) => {
    res.json(q(`SELECT m.code, m.title, m.created_at, m.last_used, u.name AS created_by_name FROM meetings m
                LEFT JOIN users u ON u.id = m.created_by
                WHERE m.created_by = ? OR m.code IN (SELECT code FROM meeting_visits WHERE user_id = ?)
                ORDER BY m.last_used DESC LIMIT 20`).all(req.user.id, req.user.id)
      .map((m) => ({ ...m, people: everyoneIn(m.code).length })));
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
    res.json({ code: m.code, title: m.title, people: everyoneIn(m.code), max: MAX_PEOPLE, ice_servers: iceServers() });
  });
  return r;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
// Polls during a meeting (while it lasts): code -> [{ id, by, by_name, question, options, votes: Map(userId -> index), closed }]
const polls = new Map();
// Q&A during a meeting (or a breakout room), while it lasts: key -> [{ id, by, by_name, text, at, votes: Set(userId), answered }]
const questions = new Map();
// The whiteboard of each meeting (or breakout room), while it lasts: key -> board (meetboard.js).
const boards = new Map();
const MAX_QUESTIONS = 200;
const questionOut = (x, userId) => ({ id: x.id, by_name: x.by_name, mine: x.by === userId, text: x.text, at: x.at, votes: x.votes.size, voted: x.votes.has(userId), answered: x.answered });
const pollOut = (p, userId) => ({ id: p.id, by: p.by, by_name: p.by_name, question: p.question, options: p.options, closed: p.closed,
  counts: p.options.map((_, i) => [...p.votes.values()].filter((v) => v === i).length), mine: p.votes.has(userId) ? p.votes.get(userId) : null, voters: p.votes.size });
// People the host removed from a meeting can't come back into it (until the server restarts).
const removed = new Map(); // code -> Set(user id)
// A meeting the host has locked: nobody new comes in (guests can't ask), but those who were in it when it was
// locked can come back (a dropped connection, a breakout room). code -> Set(user id). Open again when it empties.
const locks = new Map();
// A countdown the host starts (a timebox for an agenda item, a break): everyone in the room sees the
// same one, newcomers too. Room key → { ends_at, seconds, by }.
const timers = new Map();
// The host's settings for the whole meeting (breakout rooms too): code → { muted_entry, host_present }.
// muted_entry: people come in with their microphone off; host_present: only the host shares a screen.
const settings = new Map();
const settingsOf = (code) => ({ muted_entry: false, host_present: false, ...settings.get(code) });
// Co-hosts: people the meeting's organiser gave the host's controls to (for this meeting, while it
// lasts). code → Set of user ids.
const cohosts = new Map();
const hostOf = (m, code, userId) => m.created_by === userId || !!cohosts.get(code)?.has(userId);
// Who the host has put in the spotlight (shown big for everyone): room key → { id, by }.
const spotlights = new Map();
export const TIMER_SECONDS = { min: 10, max: 3 * 3600 };
// Whether guests without an account may ask to join the company's meetings (Admin → Company settings).
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'meet_guests')) q('ALTER TABLE orgs ADD COLUMN meet_guests INTEGER NOT NULL DEFAULT 1').run();

// Guests (people without an account, from the meeting's link) wait here until someone from the meeting's
// company lets them in: code -> Map(guestId -> { ws, name }).
const waiting = new Map();
export const MAX_WAITING = 10;
const waitingList = (code) => [...(waiting.get(code)?.entries() ?? [])].map(([id, g]) => ({ id, name: g.name }));
/** Who may let guests in: people in the meeting from its own company. */
const mayAdmit = (m, user) => !user.guest && user.org_id === m.org_id;
/** Tell everyone in the meeting who may let guests in who is waiting now. */
function knockToAdmitters(code, m) {
  const d = JSON.stringify({ type: 'knock', guests: waitingList(code) });
  for (const p of rooms.get(code)?.values() ?? []) if (mayAdmit(m, p.user) && p.ws.readyState === 1) p.ws.send(d);
}
/** May guests ask to join this company's meetings? (Admin → Company settings.) */
export const guestsAllowed = (orgId) => q('SELECT meet_guests FROM orgs WHERE id = ?').get(orgId)?.meet_guests === 1;
export const guestName = (raw) => String(raw ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** /ws/meet/<code>: join the meeting's room. */
export function handleMeetUpgrade(req, socket, head, user) {
  const code = decodeURIComponent(req.url.split('?')[0].split('/')[3] || '');
  const m = validCode(code) && q('SELECT * FROM meetings WHERE code = ?').get(code);
  if (!m || !mayJoin(m, user)) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => enterRoom(ws, req, code, m, user));
}

/**
 * /ws/meet-guest/<code>?name=…: someone without an account asks to join. They wait (told "waiting") until
 * someone from the meeting's company lets them in (then they're in the meeting as "Name (guest)") or
 * says no (closed). Works only while the company lets guests ask to join.
 */
// When each meeting's people first came in (cleared when the last one leaves), and who wants to know a call
// has ended (Chat logs "Call ended · 12 min" in the conversation it started from).
const callStart = new Map();
const endListeners = [];
/** fn(code, ms): called when the last person leaves a meeting, with how long it lasted. */
export const onCallEnded = (fn) => endListeners.push(fn);
function ended(code) {
  const start = callStart.get(code);
  callStart.delete(code);
  if (start) for (const fn of endListeners) { try { fn(code, Date.now() - start); } catch (e) { console.error('[meet] call ended:', e.message); } }
}
const toldHost = new Map(); // `${code}|${guest name}` → when its host was last told
export function handleGuestUpgrade(req, socket, head) {
  const code = decodeURIComponent(req.url.split('?')[0].split('/')[3] || '');
  const m = validCode(code) && q('SELECT * FROM meetings WHERE code = ?').get(code);
  const name = guestName(new URL(req.url, 'http://x').searchParams.get('name'));
  if (!m || !guestsAllowed(m.org_id) || !name) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (locks.has(code)) { ws.close(4005, 'The host has locked this meeting: nobody new can join'); return; }
    if (!waiting.has(code)) waiting.set(code, new Map());
    const line = waiting.get(code);
    if (line.size >= MAX_WAITING) { ws.close(4001, 'Too many people are waiting to join. Try again in a little while.'); return; }
    const gid = `guest-${crypto.randomBytes(8).toString('hex')}`;
    line.set(gid, { ws, name, req });
    ws.send(JSON.stringify({ type: 'waiting', title: m.title }));
    knockToAdmitters(code, m);
    // Nobody in the meeting can let them in (a booking-page call, say): tell whoever started it.
    if (m.created_by && !roomsOf(code).some((k) => [...(rooms.get(k)?.values() ?? [])].some((p) => mayAdmit(m, p.user)))) {
      // Once per guest name and meeting every 10 minutes (knocking again, or a dropped connection, doesn't ring again).
      const key = `${code}|${name.toLowerCase()}`;
      if ((toldHost.get(key) || 0) < Date.now() - 10 * 60e3) {
        toldHost.set(key, Date.now());
        notify([m.created_by], { kind: 'invite', title: `${name} is waiting to join “${m.title || code}”`, body: 'They’re waiting for someone from the company to let them in.', link: `/meet/${code}` });
        for (const [k, t] of toldHost) if (t < Date.now() - 36e5) toldHost.delete(k);
      }
      const host = q('SELECT name FROM users WHERE id = ?').get(m.created_by)?.name;
      if (host) ws.send(JSON.stringify({ type: 'host-told', name: host }));
    }
    ws.on('close', () => {
      if (line.get(gid)?.ws !== ws) return; // already let in (or turned away)
      line.delete(gid);
      if (!line.size) waiting.delete(code);
      knockToAdmitters(code, m);
    });
  });
}

// Breakout rooms: the host splits the meeting into smaller rooms for a while. code -> { count, assign: Map(userId -> room number) }.
// Room n of a meeting is kept in `rooms` as "code#n" (the main room is just "code").
const breakouts = new Map();
export const MAX_BREAKOUTS = 8;
const keyOf = (code, n) => (n ? `${code}#${n}` : code);
const roomsOf = (code) => [code, ...Array.from({ length: breakouts.get(code)?.count || 0 }, (_, i) => keyOf(code, i + 1))];
/** Find someone in any room of the meeting by their peer id. */
const findPeer = (code, pid) => { for (const k of roomsOf(code)) { const p = rooms.get(k)?.get(pid); if (p) return p; } return null; };
/** Who is in which breakout room, for the host (wherever they are). */
function breakoutSummary(code) {
  const b = breakouts.get(code);
  if (!b) return { type: 'breakouts', count: 0, rooms: [] };
  return { type: 'breakouts', count: b.count, rooms: Array.from({ length: b.count + 1 }, (_, n) => ({ n, people: peopleIn(keyOf(code, n)).map((p) => ({ id: p.id, name: p.user.name, guest: !!p.user.guest })) })) };
}
function summaryToHosts(code, m) {
  const d = JSON.stringify(breakoutSummary(code));
  for (const k of roomsOf(code)) for (const p of rooms.get(k)?.values() ?? []) if (p.user.id === m.created_by && p.ws.readyState === 1) p.ws.send(d);
}
/** Send someone to a room (0: the main room): they reconnect there. */
function sendToRoom(p, n, by) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'breakout', room: n, by })); }

function enterRoom(ws, req, code, m, user) {
  {
    const isOrganiser = m.created_by === user.id;
    const isHost = () => hostOf(m, code, user.id); // the organiser, or a co-host they made
    // Which room: ?room=n, if breakout rooms are open and it's yours (the host may go into any); else the main room.
    const askedRoom = Number(new URL(req.url, 'http://x').searchParams.get('room') || 0);
    const b = breakouts.get(code);
    const n = b && Number.isInteger(askedRoom) && askedRoom >= 1 && askedRoom <= b.count && !user.guest && (isHost() || b.assign.get(user.id) === askedRoom) ? askedRoom : 0;
    const key = keyOf(code, n);
    let room = rooms.get(key);
    if (room && room.size >= MAX_PEOPLE) { ws.close(4001, 'This meeting is full'); return; }
    if (removed.get(code)?.has(user.id)) { ws.close(4003, 'The host removed you from this meeting'); return; }
    if (locks.has(code) && !isHost() && !locks.get(code).has(user.id)) { ws.close(4005, 'The host has locked this meeting: nobody new can join'); return; }
    if (!room) rooms.set(key, (room = new Map()));
    if (!callStart.has(code)) callStart.set(code, Date.now()); // the first one in: the call has begun
    const id = crypto.randomBytes(8).toString('hex');
    const asked = new URL(req.url, 'http://x').searchParams; // how they come in: ?mic=0&cam=0
    const mutedEntry = !isHost() && settingsOf(code).muted_entry;
    const me = { ws, user, state: cleanState({ mic: asked.get('mic') !== '0' && !mutedEntry, cam: asked.get('cam') !== '0' }) };
    const toOthers = (payload) => { const d = JSON.stringify(payload); for (const [pid, p] of room) if (pid !== id && p.ws.readyState === 1) p.ws.send(d); };
    const toAll = (payload) => { const d = JSON.stringify(payload); for (const p of room.values()) if (p.ws.readyState === 1) p.ws.send(d); };
    ws.send(JSON.stringify({ type: 'welcome', id, peers: peopleIn(key), host: isHost(), organiser: isOrganiser, organiser_id: m.created_by, cohosts: [...(cohosts.get(code) || [])], you: user.id, guest: !!user.guest, polls: (polls.get(key) || []).map((p) => pollOut(p, user.id)), questions: (questions.get(key) || []).map((x) => questionOut(x, user.id)),
      board: boards.get(key)?.strokes || [],
      room: n, breakouts: b ? b.count : 0, locked: locks.has(code), timer: timers.get(key) || null, spotlight: spotlights.get(key) || null, settings: settingsOf(code), muted_on_entry: mutedEntry,
      admit: mayAdmit(m, user), knocking: mayAdmit(m, user) ? waitingList(code) : [] }));
    // Everyone gets a poll's results with their own vote in it.
    const questionToAll = (x) => { for (const q2 of room.values()) if (q2.ws.readyState === 1) q2.ws.send(JSON.stringify({ type: 'question', question: questionOut(x, q2.user.id) })); };
    const pollToAll = (p) => { for (const q2 of room.values()) if (q2.ws.readyState === 1) q2.ws.send(JSON.stringify({ type: 'poll', poll: pollOut(p, q2.user.id) })); };
    room.set(id, me);
    toOthers({ type: 'joined', peer: describe(id, me) });
    if (isHost()) ws.send(JSON.stringify(breakoutSummary(code)));
    if (b) summaryToHosts(code, m);
    const t = now();
    q('UPDATE meetings SET last_used = ? WHERE code = ?').run(t, code);
    if (!user.guest) q('INSERT INTO meeting_visits (code, user_id, at) VALUES (?, ?, ?) ON CONFLICT (code, user_id) DO UPDATE SET at = excluded.at').run(code, user.id, t);
    q('INSERT INTO meeting_attendance (id, code, user_id, name, email, joined_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, code, user.guest ? null : user.id, user.name, user.guest ? null : (user.email || user.username), t);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type === 'signal') {
        const to = room.get(String(msg.to));
        if (to && to.ws.readyState === 1) to.ws.send(JSON.stringify({ type: 'signal', from: id, data: msg.data }));
      } else if (msg?.type === 'state') {
        const { hand_at: _ignored, ...patch } = msg.state || {}; // when a hand went up is the server's to say
        if (patch.screen && !isHost() && settingsOf(code).host_present) { patch.screen = false; ws.send(JSON.stringify({ type: 'stop-present', reason: 'Only the host can present in this meeting' })); }
        me.state = nextState(me.state, patch);
        toAll({ type: 'state', id, state: me.state });
      } else if (msg?.type === 'chat') {
        const text = String(msg.text ?? '').trim().slice(0, 2000);
        if (text) toAll({ type: 'chat', id, name: user.name, text, at: now() });
      } else if (msg?.type === 'lower' && isHost()) {
        // The host lowers someone's hand (they've had their say), or everyone's.
        for (const [pid, p] of room) {
          if (!p.state.hand || (msg.to !== 'all' && pid !== String(msg.to))) continue;
          p.state = nextState(p.state, { hand: false });
          toAll({ type: 'state', id: pid, state: p.state });
          if (pid !== id && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'lowered', by: user.name }));
        }
      } else if ((msg?.type === 'mute' || msg?.type === 'remove') && isHost()) {
        // The host (whoever started the meeting): mute someone (or everyone else), or remove someone.
        const targets = (msg.to === 'all' && msg.type === 'mute' ? [...room.keys()].filter((pid) => pid !== id) : [String(msg.to)].filter((pid) => pid !== id && room.has(pid)))
          .filter((pid) => isOrganiser || room.get(pid).user.id !== m.created_by); // a co-host can't mute or remove the organiser
        for (const pid of targets) {
          const p = room.get(pid);
          if (msg.type === 'mute') { if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'muted', by: user.name })); continue; }
          if (!removed.has(code)) removed.set(code, new Set());
          removed.get(code).add(p.user.id);
          try { p.ws.close(4003, `${user.name} removed you from the meeting`); } catch { /* gone already */ }
        }
      } else if (msg?.type === 'ask') {
        // Q&A: ask a question (anyone in the room).
        const text = String(msg.text ?? '').trim().slice(0, 500);
        const list = questions.get(key) || [];
        if (!text || list.length >= MAX_QUESTIONS) return;
        const x = { id: crypto.randomBytes(6).toString('hex'), by: user.id, by_name: user.name, text, at: now(), votes: new Set(), answered: false };
        questions.set(key, [...list, x]);
        questionToAll(x);
      } else if (['upvote', 'answered', 'unask'].includes(msg?.type)) {
        const list = questions.get(key) || [];
        const x = list.find((y) => y.id === String(msg.id));
        if (!x) return;
        if (msg.type === 'upvote') {
          if (x.by === user.id || x.answered) return; // not your own, and not once answered
          if (msg.on === false) x.votes.delete(user.id); else x.votes.add(user.id);
        } else if (msg.type === 'answered') {
          if (x.by !== user.id && !isHost()) return; // the asker or the host
          x.answered = msg.on !== false;
        } else {
          if (x.by !== user.id && !isHost()) return; // take a question away: the asker or the host
          questions.set(key, list.filter((y) => y !== x));
          toAll({ type: 'question-gone', id: x.id });
          return;
        }
        questionToAll(x);
      } else if (msg?.type === 'poll-new') {
        const question = String(msg.question ?? '').trim().slice(0, 300);
        const options = [...new Set((Array.isArray(msg.options) ? msg.options : []).map((o) => String(o ?? '').trim().slice(0, 100)).filter(Boolean))].slice(0, 10);
        const list = polls.get(key) || [];
        if (!question || options.length < 2 || list.length >= 50) return;
        const p = { id: crypto.randomBytes(6).toString('hex'), by: user.id, by_name: user.name, question, options, votes: new Map(), closed: false };
        polls.set(key, [...list, p]);
        pollToAll(p);
      } else if (msg?.type === 'poll-vote' || msg?.type === 'poll-close') {
        const p = (polls.get(key) || []).find((x) => x.id === String(msg.id));
        if (!p) return;
        if (msg.type === 'poll-close') { if (p.by !== user.id && !isHost()) return; p.closed = true; }
        else {
          const i = Number(msg.option);
          if (p.closed || !Number.isInteger(i) || i < 0 || i >= p.options.length) return;
          p.votes.set(user.id, i); // one vote each; voting again changes it
        }
        pollToAll(p);
      } else if (msg?.type === 'end' && isHost()) {
        // The host ends the meeting for everyone: every room (breakouts too) and anyone waiting to be let in.
        const why = `${user.name} ended the meeting`;
        for (const g of waiting.get(code)?.values() ?? []) { try { g.ws.close(4006, why); } catch { /* gone */ } }
        waiting.delete(code);
        for (const k of roomsOf(code)) for (const p of [...(rooms.get(k)?.values() ?? [])]) { try { p.ws.close(4006, why); } catch { /* gone */ } }
      } else if (msg?.type === 'cohost' && isOrganiser) {
        // The organiser makes someone a co-host (or takes it back): they get the host's controls.
        const target = [...roomsOf(code)].flatMap((k) => [...(rooms.get(k)?.entries() ?? [])]).find(([pid]) => pid === String(msg.to))?.[1];
        if (!target || target.user.guest || target.user.id === user.id) return;
        if (!cohosts.has(code)) cohosts.set(code, new Set());
        if (msg.on) cohosts.get(code).add(target.user.id); else cohosts.get(code).delete(target.user.id);
        const list = JSON.stringify({ type: 'cohosts', ids: [...cohosts.get(code)] });
        for (const k of roomsOf(code)) for (const p of rooms.get(k)?.values() ?? []) {
          if (p.ws.readyState !== 1) continue;
          p.ws.send(list);
          if (p.user.id === target.user.id) {
            p.ws.send(JSON.stringify({ type: 'host', host: !!msg.on, by: user.name }));
            if (msg.on) p.ws.send(JSON.stringify(breakoutSummary(code)));
          }
        }
      } else if (msg?.type === 'settings' && isHost()) {
        // The host changes the meeting's settings: everyone in every room is told. Turning on host-only
        // presenting stops anyone else who is presenting.
        const next = { ...settingsOf(code) };
        for (const k of ['muted_entry', 'host_present']) if (typeof msg[k] === 'boolean') next[k] = msg[k];
        settings.set(code, next);
        const d = JSON.stringify({ type: 'settings', settings: next, by: user.name });
        for (const k of roomsOf(code)) for (const p of rooms.get(k)?.values() ?? []) {
          if (p.ws.readyState !== 1) continue;
          p.ws.send(d);
          if (next.host_present && p.state.screen && !hostOf(m, code, p.user.id)) p.ws.send(JSON.stringify({ type: 'stop-present', reason: `${user.name} made presenting host-only` }));
        }
      } else if (msg?.type === 'spotlight' && isHost()) {
        // The host shows someone big for everyone (a speaker, a demo), or stops (null).
        const who = msg.id == null ? null : String(msg.id);
        if (who && !room.has(who)) return;
        if (who) spotlights.set(key, { id: who, by: user.name }); else spotlights.delete(key);
        toAll({ type: 'spotlight', spotlight: spotlights.get(key) || null });
      } else if (msg?.type === 'timer' && isHost()) {
        // The host starts a countdown (or stops it: 0 seconds).
        const secs = Math.round(Number(msg.seconds));
        if (secs === 0) timers.delete(key);
        else if (Number.isFinite(secs) && secs >= TIMER_SECONDS.min && secs <= TIMER_SECONDS.max) timers.set(key, { ends_at: now() + secs * 1000, seconds: secs, by: user.name });
        else return;
        toAll({ type: 'timer', timer: timers.get(key) || null });
      } else if (msg?.type === 'lock' && isHost()) {
        // The host locks the meeting (or opens it again): everyone in every room is told; guests waiting are turned away.
        if (msg.on) {
          locks.set(code, new Set(everyoneIn(code).map((p) => p.user.id)));
          for (const g of waiting.get(code)?.values() ?? []) { try { g.ws.close(4005, 'The host has locked this meeting: nobody new can join'); } catch { /* gone */ } }
          waiting.delete(code);
          knockToAdmitters(code, m);
        } else locks.delete(code);
        const d = JSON.stringify({ type: 'locked', on: !!msg.on, by: user.name });
        for (const k of roomsOf(code)) for (const p of rooms.get(k)?.values() ?? []) if (p.ws.readyState === 1) p.ws.send(d);
      } else if ((msg?.type === 'admit' || msg?.type === 'deny') && mayAdmit(m, user)) {
        // Someone from the company lets a waiting guest in, or turns them away.
        const line = waiting.get(code);
        const g = line?.get(String(msg.id));
        if (!g) return;
        line.delete(String(msg.id));
        if (!line.size) waiting.delete(code);
        if (msg.type === 'deny') { try { g.ws.close(4004, 'Nobody in the meeting let you in'); } catch { /* gone */ } }
        else if (g.ws.readyState === 1) {
          g.ws.send(JSON.stringify({ type: 'admitted', by: user.name }));
          enterRoom(g.ws, g.req, code, m, { id: String(msg.id), name: `${g.name} (guest)`, email: null, guest: true, org_id: null });
        }
        knockToAdmitters(code, m);
      } else if (msg?.type === 'breakout-open' && isHost()) {
        // The host opens breakout rooms: { count, assign: { peerId: room } } for people in the main room
        // (guests stay in the main room). Everyone assigned is sent to theirs.
        const count = Number(msg.count);
        if (!Number.isInteger(count) || count < 2 || count > MAX_BREAKOUTS) return;
        const assign = new Map();
        const main = rooms.get(code) || new Map();
        for (const [pid, r2] of Object.entries(msg.assign || {})) {
          const p = main.get(pid);
          const to = Number(r2);
          if (p && !p.user.guest && p.user.id !== user.id && Number.isInteger(to) && to >= 1 && to <= count) assign.set(p.user.id, to);
        }
        breakouts.set(code, { count, assign });
        for (const p of main.values()) if (assign.has(p.user.id)) sendToRoom(p, assign.get(p.user.id), user.name);
        summaryToHosts(code, m);
      } else if (msg?.type === 'breakout-move' && isHost() && breakouts.has(code)) {
        // Move one person (someone who came late, say) to a room, or back to the main room (0).
        const bo = breakouts.get(code);
        const p = findPeer(code, String(msg.to));
        const to = Number(msg.room);
        if (!p || p.user.guest || p.user.id === user.id || !Number.isInteger(to) || to < 0 || to > bo.count) return;
        if (to) bo.assign.set(p.user.id, to); else bo.assign.delete(p.user.id);
        sendToRoom(p, to, user.name);
      } else if (msg?.type === 'breakout-close' && isHost() && breakouts.has(code)) {
        // Everyone comes back to the main room.
        const keys = roomsOf(code).slice(1);
        breakouts.delete(code);
        for (const k of keys) for (const p of rooms.get(k)?.values() ?? []) sendToRoom(p, 0, user.name);
        for (const p of rooms.get(code)?.values() ?? []) if (p.user.id === user.id && p.ws.readyState === 1) p.ws.send(JSON.stringify(breakoutSummary(code)));
      } else if (msg?.type === 'wb-stroke') {
        // The whiteboard: a stroke drawn (shown to everyone, the one who drew it included, in order).
        if (!boards.has(key)) boards.set(key, makeBoard());
        const s = boards.get(key).add(msg.stroke, id);
        if (s) toAll({ type: 'wb-stroke', stroke: s, name: user.name });
      } else if (msg?.type === 'wb-undo') {
        const s = boards.get(key)?.undo(id);
        if (s) toAll({ type: 'wb-remove', id: s.id });
      } else if (msg?.type === 'wb-clear') {
        if (!boards.get(key)?.strokes.length) return;
        boards.get(key).clear();
        toAll({ type: 'wb-clear', by: user.name });
      } else if (msg?.type === 'react') {
        const emoji = ['👍', '❤️', '😂', '😮', '👏', '🎉'].includes(msg.emoji) ? msg.emoji : null;
        if (emoji) toAll({ type: 'react', id, emoji });
      }
    });
    ws.on('close', () => {
      q('UPDATE meeting_attendance SET left_at = ? WHERE id = ? AND left_at IS NULL').run(now(), id);
      room.delete(id);
      if (spotlights.get(key)?.id === id) { spotlights.delete(key); const d = JSON.stringify({ type: 'spotlight', spotlight: null }); for (const p of room.values()) if (p.ws.readyState === 1) p.ws.send(d); }
      if (!room.size) { rooms.delete(key); polls.delete(key); questions.delete(key); boards.delete(key); timers.delete(key); spotlights.delete(key); } // polls last as long as the meeting (or the room)
      if (roomsOf(code).every((k) => !rooms.get(k)?.size)) { locks.delete(code); settings.delete(code); cohosts.delete(code); ended(code); } // everyone has gone: open again, settings back to usual
      if (breakouts.has(code)) {
        if (roomsOf(code).every((k) => !rooms.get(k)?.size)) breakouts.delete(code); // everyone has gone
        else summaryToHosts(code, m);
      }
      toOthers({ type: 'left', id });
    });
  }
}
