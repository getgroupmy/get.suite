// Time blocks for tasks: "Schedule time" on a task puts an event on your calendar for working on it, with
// a link back to the task. The event remembers its task (events.task_id), so the task can show when it's
// planned, and the event's window can open the task.
import { q } from './db.js';
import { uid, now, bad } from './util.js';
import { expand } from './calmath.js';
import { outEvent, touch } from './routes/calendar.js';

if (!q('PRAGMA table_info(events)').all().some((c) => c.name === 'task_id')) q('ALTER TABLE events ADD COLUMN task_id TEXT').run();

export const MAX_BLOCK_MS = 8 * 3600e3;

/** Your busy events overlapping [start, end) (repeating ones included; "free" ones and other blocks for this task not). */
export function clashes(userId, start, end, taskId = null) {
  const rows = q(`SELECT * FROM events WHERE owner_id = ? AND recur_parent IS NULL AND start < ? AND (show_as IS NULL OR show_as != 'free') AND (task_id IS NULL OR task_id != ?)
                  AND (end > ? OR (rrule IS NOT NULL AND (repeat_until IS NULL OR repeat_until > ?)))`).all(userId, end, taskId || '', start, start);
  const guestRows = q(`SELECT e.* FROM events e JOIN event_guests g ON g.event_id = e.id AND g.user_id = ? AND g.status IN ('yes', 'maybe', 'needs')
                       WHERE e.start < ? AND (e.end > ? OR e.rrule IS NOT NULL)`).all(userId, end, start);
  return [...rows, ...guestRows].filter((r) => expand(outEvent(r), start, end).some((o) => o.start < end && o.end > start))
    .map((r) => ({ id: r.id, title: r.title || '(No title)' }));
}

/** Put a block on this person's calendar for a task: { start, end, tz }. Returns the event and what it clashes with. */
export function scheduleTask(user, task, { start, end, tz, link }) {
  start = Number(start); end = Number(end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw bad('Choose when, and for how long');
  if (end - start > MAX_BLOCK_MS) throw bad('A block can be at most 8 hours');
  const clash = clashes(user.id, start, end, task.id);
  const id = uid();
  q(`INSERT INTO events (id, owner_id, title, description, start, end, all_day, exdates, tz, task_id) VALUES (?, ?, ?, ?, ?, ?, 0, '[]', ?, ?)`)
    .run(id, user.id, `✓ ${task.title}`, `Time for the task “${task.title}”: ${link}`, start, end, String(tz || 'UTC').slice(0, 64), task.id);
  touch([user.id]);
  return { event: { id, title: `✓ ${task.title}`, start, end }, clashes: clash };
}

/** This person's coming blocks for a task (ending after now), soonest first. */
export const blocksOf = (userId, taskId, t = now()) => q('SELECT id, title, start, end FROM events WHERE owner_id = ? AND task_id = ? AND end > ? ORDER BY start').all(userId, taskId, t);
