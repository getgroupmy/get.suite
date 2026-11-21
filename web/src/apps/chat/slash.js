import { parseQuickEvent } from '../calendar/quickevent.js';
// Slash commands typed at the start of the message box: /meet, /poll Question | option | option, /task title, /status, /thanks,
// /invite, /topic, /mute, /leave, /remind.
// alone: complete with nothing after it, so Enter on exactly "/meet" or "/status" runs it rather than picking it from the list.
export const SLASH = [
  { cmd: 'meet', alone: true, hint: '/meet', what: 'start a video meeting and share it here' },
  { cmd: 'poll', hint: '/poll Question | option | option', what: 'ask a question with options' },
  { cmd: 'task', hint: '/task what to do', what: 'add a task to your list (with a link to here)' },
  { cmd: 'event', alone: true, hint: '/event Planning fri 3pm', what: 'a calendar event with the people here (alone: the first free time)' },
  { cmd: 'dnd', alone: true, hint: '/dnd 2h', what: 'pause notifications (an hour; /dnd off resumes them)' },
  { cmd: 'status', alone: true, hint: '/status 🍔 Lunch 1h', what: 'set your status (/status alone clears it)' },
  { cmd: 'thanks', hint: '/thanks @someone 🎉 for the demo', what: 'thank a colleague (on their card and Home, and posted here)' },
  { cmd: 'invite', hint: '/invite @someone @someone', what: 'add colleagues to this channel (they’re told)' },
  { cmd: 'topic', alone: true, hint: '/topic what it’s about', what: 'set the channel’s topic (alone: clear it)' },
  { cmd: 'mute', alone: true, hint: '/mute 2h', what: 'mute this conversation (for a while, or until /mute off)' },
  { cmd: 'leave', alone: true, hint: '/leave', what: 'leave this channel' },
  { cmd: 'remind', hint: '/remind me to call Kim in 2h', what: 'a reminder for you, or @someone (in 2h, tomorrow 9am, every fri 4pm…)' },
];

const UNIT = { m: 60e3, h: 36e5, d: 864e5, w: 7 * 864e5 };
/**
 * "/remind me to call Kim in 2 hours" (or "tomorrow 9am", "fri 3pm", "at 4pm", "monday"): { text, at } (ms), or
 * { error }. `now` is a Date. A day without a time is 9:00 that day. Times are read as Calendar's quick add reads them.
 */
export function remindWhen(input, now = new Date()) {
  let s = String(input || '').trim();
  // "@kim@acme.com to …": for a colleague (as the @ list writes them); "me": yourself.
  const who = /^@([\w.+-]+@[\w.-]+\.[a-z]{2,})\s+/i.exec(s);
  if (who) s = s.slice(who[0].length);
  s = s.replace(/^me\s+/i, '').replace(/^(?:to|about|that)\s+/i, '');
  let at = null, text = s, repeat = null;
  const rel = /\s+in\s+(\d{1,4}|an?|one|half\s+an?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/i.exec(` ${s}`);
  if (rel) {
    const n = /^half/i.test(rel[1]) ? 0.5 : /^\d/.test(rel[1]) ? Number(rel[1]) : 1;
    at = now.getTime() + n * UNIT[rel[2][0].toLowerCase()];
    text = ` ${s}`.slice(0, rel.index).trim();
  } else {
    const pad = (x) => String(x).padStart(2, '0');
    const q = parseQuickEvent(s, { today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` });
    if (q?.found?.length) {
      at = q.all_day ? new Date(q.start).setHours(9, 0, 0, 0) : q.start;
      text = q.title;
      // "every friday 4pm", "every weekday 9:30am": repeating, as Calendar repeats (its first time may be passed today).
      if (q.rrule) repeat = { rule: q.rrule, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (at == null) return { error: 'Say when: /remind me to call Kim in 2h (or tomorrow 9am, fri 3pm)' };
  if (!text) return { error: 'Say what to remind you of: /remind me to call Kim in 2h' };
  if (at < now.getTime() + 30e3 && !repeat) return { error: 'That time has passed: pick a later one' };
  if (at > now.getTime() + 365 * 864e5) return { error: 'A reminder can be up to a year ahead' };
  if (text.length > 500) return { error: 'A reminder is at most 500 characters' };
  return { text, at, ...(who && { for: who[1].toLowerCase() }), ...(repeat && { repeat }) };
}

/** "/invite @kim@acme.com @ben@acme.com": { usernames }. */
function parseInvite(rest) {
  const words = rest.split(/[\s,]+/).filter(Boolean);
  const usernames = words.map((w) => /^@?([\w.+-]+@[\w.-]+\.[a-z]{2,})$/i.exec(w)?.[1]?.toLowerCase());
  if (!words.length || usernames.some((u) => !u)) return { cmd: 'invite', error: 'Write it as /invite @someone (pick them from the @ list)' };
  return { cmd: 'invite', usernames: [...new Set(usernames)] };
}

/** "/mute [30m | 2 hours | off]": { minutes } for a while, {} until unmuted, or { off: true }. */
function parseMute(rest) {
  if (!rest) return { cmd: 'mute' };
  if (/^(off|unmute|stop)$/i.test(rest)) return { cmd: 'mute', off: true };
  const m = /^(?:for\s+)?(\d{1,5})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i.exec(rest);
  if (!m) return { cmd: 'mute', error: 'Write it as /mute, /mute 2h, /mute 3 days or /mute off' };
  const minutes = Number(m[1]) * (/^h/i.test(m[2]) ? 60 : /^d/i.test(m[2]) ? 1440 : 1);
  if (!minutes || minutes > 365 * 1440) return { cmd: 'mute', error: 'A conversation can be muted for a minute up to a year' };
  return { cmd: 'mute', minutes };
}

const KUDOS_EMOJI = ['🙌', '🎉', '💪', '🌟', '🙏', '🚀', '❤️', '🏆'];
/** "/thanks @kim@acme.com [emoji] what for": { to: 'kim@acme.com', emoji, message }. */
function parseThanks(rest) {
  const m = /^@([\w.+-]+@[\w.-]+\.[a-z]{2,})\s*([\s\S]*)$/i.exec(rest);
  if (!m) return { cmd: 'thanks', error: 'Write it as /thanks @someone what for' };
  let message = m[2].trim(), emoji;
  const e = EMOJI.exec(message);
  const bare = (x) => x.replace(/\uFE0F/g, ''); // ❤️ with or without its variation selector
  const found = e && KUDOS_EMOJI.find((k) => bare(k) === bare(e[1]));
  if (found) { emoji = found; message = message.slice(e[0].length).trim(); }
  if (!message) return { cmd: 'thanks', error: 'Say what you’re thanking them for' };
  if (message.length > 280) return { cmd: 'thanks', error: 'A thank-you is at most 280 characters' };
  return { cmd: 'thanks', to: m[1].toLowerCase(), message, ...(emoji && { emoji }) };
}

// A leading emoji (with skin tones, joiners and variation selectors), and how long a status lasts.
const EMOJI = /^(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*)\s*/u;
const LASTS = /\s+(?:for\s+)?(?:(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?)|(today|(?:this\s+)?week))$/i;

/** "/dnd [30m | 2 hours | tomorrow | off]": { minutes }, { tomorrow: true } (9:00) or { off: true }. An hour when not said. */
function parseDnd(rest) {
  if (!rest) return { cmd: 'dnd', minutes: 60 };
  if (/^(off|on|resume|stop)$/i.test(rest)) return { cmd: 'dnd', off: true };
  if (/^(until\s+)?tomorrow$/i.test(rest)) return { cmd: 'dnd', tomorrow: true };
  const m = /^(?:for\s+)?(\d{1,5})\s*(m|mins?|minutes?|h|hrs?|hours?)$/i.exec(rest);
  if (!m) return { cmd: 'dnd', error: 'Write it as /dnd 30m, /dnd 2h, /dnd tomorrow or /dnd off' };
  const minutes = Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1);
  if (!minutes || minutes > 31 * 24 * 60) return { cmd: 'dnd', error: 'Notifications can be paused for a minute up to a month' };
  return { cmd: 'dnd', minutes };
}

/** "/status …": { clear: true }, or { emoji, text, after } where after is minutes, 'today' or 'week' (today when not said). */
function parseStatus(rest) {
  if (!rest || /^(clear|off|none)$/i.test(rest)) return { cmd: 'status', clear: true };
  let after = 'today';
  const m = LASTS.exec(` ${rest}`);
  if (m) {
    if (m[3]) after = /week/i.test(m[3]) ? 'week' : 'today';
    else {
      after = Number(m[1]) * (/^h/i.test(m[2]) ? 60 : 1);
      if (!after || after > 366 * 24 * 60) return { cmd: 'status', error: 'A status can last from a minute to a year' };
    }
    rest = ` ${rest}`.slice(0, m.index).trim();
  }
  const e = EMOJI.exec(rest);
  const emoji = e ? e[1] : '💬';
  const text = (e ? rest.slice(e[0].length) : rest).trim();
  if (!text && !e) return { cmd: 'status', error: 'Write it as /status 🍔 Lunch 1h' };
  if (text.length > 100) return { cmd: 'status', error: 'A status is at most 100 characters' };
  return { cmd: 'status', emoji, text, after };
}

/** What a message box's text asks for: null when it isn't a command (plain text, or an unknown /word sent as is). */
export function parseSlash(text) {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  if (cmd === 'meet') return { cmd };
  if (cmd === 'status') return parseStatus(rest);
  if (cmd === 'dnd') return parseDnd(rest);
  if (cmd === 'event') return { cmd, text: rest.slice(0, 300) };
  if (cmd === 'thanks') return parseThanks(rest);
  if (cmd === 'invite') return parseInvite(rest);
  if (cmd === 'topic') return rest.length > 250 ? { cmd, error: 'A topic is at most 250 characters' } : { cmd, topic: rest };
  if (cmd === 'mute') return parseMute(rest);
  if (cmd === 'remind') return rest ? { cmd, text: rest } : { cmd, error: 'Write it as /remind me to call Kim in 2h' };
  if (cmd === 'leave') return rest ? null : { cmd }; // "/leave early" is just a message
  if (cmd === 'task') return rest ? { cmd, title: rest.slice(0, 500) } : { cmd, error: 'Write the task after /task' };
  if (cmd === 'poll') {
    const [question, ...opts] = rest.split('|').map((x) => x.trim());
    const options = opts.filter(Boolean);
    if (!question || options.length < 2) return { cmd, error: 'Write it as /poll Question | option | option' };
    if (options.length > 10) return { cmd, error: 'At most 10 options' };
    return { cmd, question, options };
  }
  return null;
}

/** The commands to suggest while typing "/…" (before any space). */
export const slashSuggestions = (text) => {
  const m = /^\/([a-z]*)$/i.exec(String(text || ''));
  return m ? SLASH.filter((s) => s.cmd.startsWith(m[1].toLowerCase())) : [];
};
