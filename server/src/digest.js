// The morning summary: an email each day at the hour someone chooses (in their time zone) with
// today's events, the tasks due today or overdue, how many chat messages are waiting, and what others
// changed in Drive (files they can open) in the last day, and open comments that @mention them or are assigned to them. Sent from
// their own mailbox to itself, so it needs this server's email to be on.
import { q } from './db.js';
import { expand } from './calmath.js';
import { zonedToUtc, zoneOrUtc } from './ics.js';
import { outEvent } from './routes/calendar.js';
import { mailEnabled } from './mail/config.js';
import { smtpFor } from './mail/imap.js';
import { recentActivityFor } from './fileactivity.js';
import { roleFor } from './access.js';
import { commentsFor } from './routes/comments.js';
import { datesOn } from './contactreminders.js';

for (const [col, type] of [['digest_hour', 'INTEGER'], ['digest_tz', 'TEXT'], ['digest_last', 'TEXT'], ['digest_off', 'TEXT'], ['digest_weekdays', 'INTEGER'], ['digest_skip_empty', 'INTEGER']]) {
  if (!q('PRAGMA table_info(users)').all().some((c) => c.name === col)) q(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run();
}

/** The parts of the summary, which each person can leave out. */
export const DIGEST_PARTS = ['events', 'tasks', 'dates', 'chat', 'comments', 'drive'];
/** The parts someone left out of their summary. */
export function digestOff(userId) {
  try { return JSON.parse(q('SELECT digest_off FROM users WHERE id = ?').get(userId)?.digest_off || '[]').filter((p) => DIGEST_PARTS.includes(p)); } catch { return []; }
}
export function setDigestOff(userId, off) {
  const list = [...new Set((Array.isArray(off) ? off : []).map(String))].filter((p) => DIGEST_PARTS.includes(p));
  q('UPDATE users SET digest_off = ? WHERE id = ?').run(list.length ? JSON.stringify(list) : null, userId);
  return list;
}

/** The local date ("2026-11-09") and hour at time t in a time zone. */
export function localNow(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** What goes in someone's summary for the local day containing t. */
export function digestFor(userId, t = Date.now(), base = process.env.PUBLIC_URL || '') {
  base = String(base || '').replace(/\/+$/, '');
  const link = (path) => (base ? `\n      ${base}${path}` : '');
  const user = q('SELECT id, username, name, org_id, digest_tz FROM users WHERE id = ?').get(userId);
  const tz = zoneOrUtc(user.digest_tz || 'UTC');
  const { date } = localNow(t, tz);
  const [y, m, d] = date.split('-').map(Number);
  const from = zonedToUtc(y, m, d, 0, 0, 0, tz), to = zonedToUtc(y, m, d + 1, 0, 0, 0, tz);
  const rows = q(`SELECT e.*, g.status AS my_status FROM events e LEFT JOIN event_guests g ON g.event_id = e.id AND g.user_id = ?
                  WHERE (e.owner_id = ? OR (g.user_id IS NOT NULL AND g.status != 'no')) AND e.start < ?
                    AND (e.end >= ? OR (e.rrule IS NOT NULL AND (e.repeat_until IS NULL OR e.repeat_until >= ?)))`).all(userId, userId, to, from, from);
  const events = rows.flatMap((r) => expand(outEvent(r), from, to)).filter((e) => e.start < to && e.end > from)
    .sort((a, b) => (b.all_day - a.all_day) || (a.start - b.start));
  const tasks = q(`SELECT t.title, t.due, t.due_time, l.name AS list FROM tasks t JOIN task_lists l ON l.id = t.list_id
                   WHERE t.done_at IS NULL AND t.due IS NOT NULL AND t.due <= ? AND (t.assignee_id = ? OR (t.assignee_id IS NULL AND l.owner_id = ?))
                   ORDER BY t.due, t.due_time IS NULL, t.due_time LIMIT 50`).all(date, userId, userId);
  const unread = q(`SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id
                    WHERE (m.user_id IS NULL OR m.user_id != ?) AND m.parent_id IS NULL
                      AND ((c.dm_key IS NULL AND c.private = 0 AND c.org_id = ? AND c.archived_at IS NULL) OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
                      AND m.created_at > COALESCE((SELECT read_at FROM channel_reads r WHERE r.channel_id = c.id AND r.user_id = ?), 0)`).get(userId, user.org_id, userId, userId).n;
  const time = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  const dayName = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(from + 12 * 36e5));
  const off = new Set(digestOff(userId));
  const lines = [`Good morning, ${user.name.split(' ')[0]}. Here's ${dayName}.`, ...(base ? [`Open Workspace: ${base}/home`] : []), ''];
  if (!off.has('events')) {
    lines.push(events.length ? `Today (${events.length} event${events.length === 1 ? '' : 's'}):${link('/calendar')}` : 'No events today.');
    for (const e of events) lines.push(`  ${e.all_day ? 'All day' : `${time(e.start)}–${time(e.end)}`}  ${e.title}${e.location ? ` (${e.location})` : ''}${e.my_status === 'needs' ? ' — not answered yet' : ''}`);
    lines.push('');
  }
  if (!off.has('tasks')) {
    lines.push(tasks.length ? `Tasks due (${tasks.length}):${link('/tasks/myday')}` : 'No tasks due.');
    for (const k of tasks) lines.push(`  ${k.due < date ? `Overdue (${k.due})` : k.due_time ? `Today ${k.due_time}` : 'Today'}  ${k.title}  [${k.list}]`);
    lines.push('');
  }
  let dates = [];
  if (!off.has('dates')) { try { dates = datesOn(userId, date); } catch { dates = []; } } // no contacts yet
  if (dates.length) {
    lines.push(`Birthdays and dates today:`);
    for (const x of dates) lines.push(`  ${x.what === 'birthday' ? `🎂 ${x.name}’s birthday${x.years ? ` (${x.years})` : ''}` : `${x.name}: ${x.what}${x.years ? ` (${x.years} years)` : ''}`}${link(`/contacts?q=${encodeURIComponent(x.name)}`)}`);
    lines.push('');
  }
  if (unread && !off.has('chat')) lines.push(`${unread} unread chat message${unread === 1 ? '' : 's'}.${link('/chat')}`, '');
  const comments = off.has('comments') ? [] : commentsFor(user);
  if (comments.length) {
    lines.push(`Comments for you (${comments.length}):`);
    for (const c of comments.slice(0, 6)) {
      const text = c.body.replace(/\s+/g, ' ');
      lines.push(`  “${c.file.name}”: ${c.author_name || 'Someone'}${c.assigned ? ' assigned you' : ''}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}${link(c.link)}`);
    }
    if (comments.length > 6) lines.push(`  and ${comments.length - 6} more (Home → Comments for you)`);
    lines.push('');
  }
  const drive = off.has('drive') ? [] : driveChanges(userId, t);
  if (drive.length) {
    lines.push(`Changed in Drive since yesterday (${drive.length} file${drive.length === 1 ? '' : 's'}):`);
    for (const f of drive.slice(0, 8)) lines.push(`  “${f.name}”: ${f.what}${link(f.path)}`);
    if (drive.length > 8) lines.push(`  and ${drive.length - 8} more (Drive → Activity)${link('/drive/activity')}`);
    lines.push('');
  }
  lines.push('You get this because you turned on the morning summary in Workspace → Settings.');
  return { date, subject: `Your day: ${dayName}`, text: lines.join('\n'), events: events.length, tasks: tasks.length, unread, drive: drive.length, comments: comments.length,
    // Nothing in the parts it has: no events, tasks, unread chat, comments or Drive changes.
    empty: !((off.has('events') ? 0 : events.length) + (off.has('tasks') ? 0 : tasks.length) + (off.has('chat') ? 0 : unread) + dates.length + comments.length + drive.length), dates: dates.length };
}

const PATH = { doc: (id) => `/docs/${id}`, sheet: (id) => `/sheets/${id}`, slides: (id) => `/slides/${id}`, folder: (id) => `/drive/folder/${id}` };
const VERB = { create: 'made', upload: 'uploaded', copy: 'copied', request: 'sent in', edit: 'edited', version: 'restored', rename: 'renamed', move: 'moved',
  trash: 'trashed', restore: 'restored', share: 'shared', transfer: 'given', lock: 'locked', unlock: 'unlocked', approval: 'approval' };
/** Files others changed in the last 24 hours that this person can open: [{ name, what: "edited by Kim, Len; renamed by Kim" }], most recent first. */
export function driveChanges(userId, t = Date.now()) {
  const since = t - 864e5;
  const acts = recentActivityFor(userId, (id) => roleFor(id, userId), { limit: 300, days: 2 }).filter((a) => a.at >= since && a.at <= t);
  const files = new Map();
  for (const a of acts) {
    if (!files.has(a.file.id)) files.set(a.file.id, { name: a.file.name, path: PATH[a.file.kind]?.(a.file.id) || `/drive?preview=${a.file.id}`, verbs: new Map() });
    const verbs = files.get(a.file.id).verbs, v = VERB[a.action] || a.action;
    if (!verbs.has(v)) verbs.set(v, new Set());
    verbs.get(v).add((a.user_name || 'Someone').split(' ')[0]);
  }
  return [...files.values()].map((f) => ({ name: f.name, path: f.path, what: [...f.verbs].map(([v, who]) => `${v} by ${[...who].join(', ')}`).join('; ') }));
}

/** Send someone their summary now (from their own mailbox to itself). */
export async function sendDigest(userId, t = Date.now(), base = process.env.PUBLIC_URL || '') {
  const user = q('SELECT id, username, name FROM users WHERE id = ?').get(userId);
  const d = digestFor(userId, t, base);
  await smtpFor(user).sendMail({ from: { name: 'Workspace', address: user.username }, to: user.username, subject: d.subject, text: d.text });
  return d;
}

/** Is a local date ("2026-11-14") a Saturday or Sunday? */
/** Is someone on approved time off the whole of a local date (a half day doesn't count)? */
export function offAllDay(userId, date) {
  try {
    return !!q(`SELECT 1 FROM time_off WHERE user_id = ? AND status = 'approved' AND half IS NULL AND start_date <= ? AND end_date >= ?`).get(userId, date, date);
  } catch { return false; } // no time-off table yet
}
export const isWeekend = (date) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());

let running = false;
/** Send the summaries that are due: past each person's hour, once per local day. */
export async function sendDueDigests(t = Date.now()) {
  if (running || !mailEnabled()) return 0;
  running = true;
  let n = 0;
  try {
    for (const u of q('SELECT id, digest_hour, digest_tz, digest_last, digest_weekdays, digest_skip_empty FROM users WHERE digest_hour IS NOT NULL AND disabled = 0').all()) {
      const { date, hour } = localNow(t, zoneOrUtc(u.digest_tz || 'UTC'));
      if (hour < u.digest_hour || u.digest_last === date) continue;
      if (u.digest_weekdays && isWeekend(date)) continue; // Monday to Friday only
      if (offAllDay(u.id, date)) continue; // on holiday: no summary
      q('UPDATE users SET digest_last = ? WHERE id = ?').run(date, u.id); // once a day, even if sending fails
      if (u.digest_skip_empty && digestFor(u.id, t).empty) continue; // nothing to say today
      try { await sendDigest(u.id, t); n++; } catch (e) { console.error('[digest]', e.message); }
    }
  } finally { running = false; }
  return n;
}
