// Quick actions in the top bar's search: type what you want to do ("new doc", "compose", "event")
// and it's offered first. Each has words it answers to; every word typed must start one of them.
// "event Lunch with @kim tomorrow 1pm" and "task Send invoice friday !" are read by Calendar's and
// Tasks' quick add, and offered as that very event or task.
import { parseQuickEvent } from '../apps/calendar/quickevent.js';
import { parseQuickAdd } from '../apps/tasks/quickadd.js';
export const ACTIONS = [
  { key: 'doc', title: 'New document', icon: 'doc', words: 'new document doc write docs', make: 'doc' },
  { key: 'sheet', title: 'New spreadsheet', icon: 'sheet', words: 'new spreadsheet sheet sheets excel table', make: 'sheet' },
  { key: 'slides', title: 'New presentation', icon: 'slides', words: 'new presentation slides deck powerpoint', make: 'slides' },
  { key: 'mail', title: 'Write an email', icon: 'mail', words: 'new email compose write message mail send', to: '/mail?compose=', needsMail: true },
  { key: 'event', title: 'New event', icon: 'calendar', words: 'new event meeting calendar appointment schedule', event: true },
  { key: 'task', title: 'Tasks', icon: 'check', words: 'new task tasks todo to-do', to: '/tasks' },
  { key: 'note', title: 'Notes', icon: 'note', words: 'new note notes keep', to: '/notes' },
  { key: 'meet', title: 'Start a video meeting', icon: 'video', words: 'new meet meeting video call', to: '/meet' },
  { key: 'settings', title: 'Settings', icon: 'settings', words: 'settings preferences password account signature', to: '/settings' },
  { key: 'admin', title: 'Admin', icon: 'shield', words: 'admin users people company', to: '/admin', adminOnly: true },
];

/** The actions that answer to what was typed (each word must start one of theirs), at most `max`. */
export function matchActions(text, { mail = true, admin = false, max = 3 } = {}) {
  const typed = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!typed.length || typed.join('').length < 2) return [];
  return ACTIONS.filter((a) => (mail || !a.needsMail) && (admin || !a.adminOnly))
    .filter((a) => { const words = `${a.title} ${a.words}`.toLowerCase().split(/\s+/); return typed.every((t) => words.some((w) => w.startsWith(t))); })
    .slice(0, max);
}

const EVENT_WORDS = /^(?:new\s+)?(?:event|meeting|appointment)\s+(.+)$/i;
const TASK_WORDS = /^(?:new\s+)?(?:task|todo|to-do|remind\s+me\s+to)\s+(.+)$/i;
/** Whether a line starts like a detailed event (so the caller knows to have people and rooms ready). */
export const wantsEvent = (text) => EVENT_WORDS.test(String(text || '').trim());

/**
 * "event …" or "task …" with details: [{ key, title, sub, quickEvent | quickTask }] (one at most), or [].
 * An event needs a day or time in it; a task just words after "task".
 */
export function detailedActions(text, { today, people = [], rooms = [], minutes = 60 } = {}) {
  const t = String(text || '').trim();
  let m = EVENT_WORDS.exec(t);
  if (m) {
    const ev = parseQuickEvent(m[1], { today, people, rooms, minutes });
    if (!ev) return [];
    return [{ key: 'qevent', icon: 'calendar', title: `New event: ${ev.title || '(no title)'}`, quickEvent: ev }];
  }
  m = TASK_WORDS.exec(t);
  if (m) {
    const q = parseQuickAdd(m[1], { today });
    if (!q.title) return [];
    const task = { title: q.title, due: q.due, due_time: q.due_time, repeat: q.repeat, important: q.important, ...(q.priority && { priority: q.priority }), tags: q.tags };
    return [{ key: 'qtask', icon: 'check', title: `Add task: ${q.title}`, quickTask: task, found: q.found }];
  }
  return [];
}
