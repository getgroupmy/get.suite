// Quick actions in the top bar's search: type what you want to do ("new doc", "compose", "event")
// and it's offered first. Each has words it answers to; every word typed must start one of them.
// "event Lunch with @kim tomorrow 1pm" and "task Send invoice friday !" are read by Calendar's and
// Tasks' quick add, and offered as that very event or task.
import { parseQuickEvent, guestsIn, tidy } from '../apps/calendar/quickevent.js';
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

const NOTE_WORDS = /^(?:new\s+)?(note|list|checklist)\s+(.+)$/i;
const MAIL_WORDS = /^(?:new\s+)?(?:email|mail|message|write\s+to)\s+(.+)$/i;
/** Whether a line wants colleagues looked up (an event's guests, an email's recipients). */
export const wantsPeople = (text) => [EVENT_WORDS, MAIL_WORDS, CHAT_WORDS].some((re) => re.test(String(text || '').trim()));

/**
 * "note Call the bank", "list milk, eggs, bread #shopping": a note (a checklist for "list", its items split at
 * commas), with "#label"s as its labels. Null when there's nothing to keep.
 */
export function noteFrom(kind, rest) {
  const labels = [];
  const words = ` ${rest} `.replace(/\s#(\p{L}[\p{L}\p{N}_-]{0,29})(?=[\s,.]|$)/gu, (_, l) => { if (!labels.includes(l.toLowerCase())) labels.push(l.toLowerCase()); return ' '; }).replace(/\s+/g, ' ').trim();
  if (!words) return null;
  if (/list/i.test(kind)) {
    const items = words.split(/\s*,\s*/).filter(Boolean).slice(0, 100);
    return items.length ? { items: items.map((text) => ({ text, done: false })), labels } : null;
  }
  return { body: words.slice(0, 20000), labels };
}

/** "email @kim and jo@client.com about Budget figures": { to: [addresses], subject }. Colleagues by "@name" (from `people`). */
export function mailFrom(rest, people = []) {
  const who = guestsIn(rest, people, { drop: true });
  const subject = tidy(who.text).replace(/^(?:about|re:?|regarding|subject:?|[-:])\s*/i, '').trim();
  return { to: who.guests, subject };
}

const CHAT_WORDS = /^(?:chat|dm|message\s+in)\s+([@#].*)$/i;
/** Whether a line wants conversations looked up ("chat #launch …"). */
export const wantsChannels = (text) => CHAT_WORDS.test(String(text || '').trim());

/**
 * "chat @kim Are we still on?" or "chat #launch Shipped!": { person | channel, text } — who or where (one colleague
 * from `people` by "@Full Name", "@first" or "@address-part", or an open channel you're in from `channels` by name)
 * and the words to start the message with. Null when it names nobody (or more than one Kim).
 */
export function chatFrom(rest, { people = [], channels = [] } = {}) {
  const r = String(rest || '').trim();
  const words = (n) => r.split(/\s+/).slice(n).join(' ').replace(/^[:,-]\s*/, '');
  if (r.startsWith('#')) {
    const name = /^#([^\s]+)/.exec(r)?.[1]?.toLowerCase();
    const c = channels.find((x) => !x.dm_key && !x.archived_at && x.name?.toLowerCase() === name);
    return c ? { channel: c, text: words(1) } : null;
  }
  const lower = r.slice(1).toLowerCase();
  const full = people.filter((p) => p.name && (lower === p.name.toLowerCase() || lower.startsWith(`${p.name.toLowerCase()} `) || lower.startsWith(`${p.name.toLowerCase()}:`) || lower.startsWith(`${p.name.toLowerCase()},`)));
  if (full.length === 1) return { person: full[0], text: words(full[0].name.split(/\s+/).length) };
  const first = /^@([^\s:,]+)/.exec(r)?.[1]?.toLowerCase();
  if (!first) return null;
  const hits = people.filter((p) => p.name?.toLowerCase().split(/\s+/)[0] === first || p.username?.toLowerCase().split('@')[0] === first);
  return hits.length === 1 ? { person: hits[0], text: words(1) } : null;
}

const FILE_WORDS = /^(?:new\s+)?(doc|document|sheet|spreadsheet|slides|presentation|deck)\s+(.+)$/i;
const FILE_KIND = { doc: 'doc', document: 'doc', sheet: 'sheet', spreadsheet: 'sheet', slides: 'slides', presentation: 'slides', deck: 'slides' };
const FILE_NAME = { doc: 'document', sheet: 'spreadsheet', slides: 'presentation' };

const EVENT_WORDS = /^(?:new\s+)?(?:event|meeting|appointment)\s+(.+)$/i;
const TASK_WORDS = /^(?:new\s+)?(?:task|todo|to-do|remind\s+me\s+to)\s+(.+)$/i;
/** Whether a line starts like a detailed event (so the caller knows to have people and rooms ready). */
export const wantsEvent = (text) => EVENT_WORDS.test(String(text || '').trim());

/**
 * "event …", "task …", "note …" / "list …", "email @…", "chat @…" or "doc Q3 plan" with details: [{ key, title, quickEvent | quickTask | quickNote | quickMail }]
 * (one at most), or [].
 * An event needs a day or time in it; a task just words after "task".
 */
export function detailedActions(text, { today, people = [], rooms = [], channels = [], minutes = 60, mail = true } = {}) {
  const t = String(text || '').trim();
  let m = EVENT_WORDS.exec(t);
  if (m) {
    const ev = parseQuickEvent(m[1], { today, people, rooms, minutes });
    if (!ev) return [];
    return [{ key: 'qevent', icon: 'calendar', title: `New event: ${ev.title || '(no title)'}`, quickEvent: ev }];
  }
  m = NOTE_WORDS.exec(t);
  if (m) {
    const note = noteFrom(m[1], m[2]);
    if (!note) return [];
    const what = note.items ? note.items.map((i) => i.text).join(', ') : note.body;
    return [{ key: 'qnote', icon: 'note', title: `${note.items ? 'Add checklist' : 'Add note'}: ${what.slice(0, 80)}`, quickNote: note }];
  }
  m = MAIL_WORDS.exec(t);
  if (m && mail) {
    const msg = mailFrom(m[1], people);
    // nobody to write to: the plain "Write an email" does (or a chat, for "message in #…")
    if (msg.to.length) return [{ key: 'qmail', icon: 'mail', title: `Email ${msg.to.map((a) => people.find((p) => p.username.toLowerCase() === a)?.name || a).join(', ')}`, quickMail: msg }];
  }
  m = CHAT_WORDS.exec(t);
  if (m) {
    const c = chatFrom(m[1], { people, channels });
    if (!c) return [];
    const where = c.person ? c.person.name : `#${c.channel.name}`;
    return [{ key: 'qchat', icon: 'chat', title: c.text ? `Message ${where}: ${c.text.slice(0, 80)}` : `Open chat with ${where}`, quickChat: c }];
  }
  m = FILE_WORDS.exec(t);
  if (m) {
    const kind = FILE_KIND[m[1].toLowerCase()];
    const name = m[2].replace(/^(?:called|named)\s+/i, '').replace(/^["“”']|["“”']$/g, '').replace(/[/\\]/g, '-').trim().slice(0, 200); // Drive names can't have / or \
    if (name) return [{ key: `qfile${kind}`, icon: kind, title: `New ${FILE_NAME[kind]}: ${name}`, make: kind, name }];
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
