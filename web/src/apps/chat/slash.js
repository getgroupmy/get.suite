// Slash commands typed at the start of the message box: /meet, /poll Question | option | option, /task title, /status.
// alone: complete with nothing after it, so Enter on exactly "/meet" or "/status" runs it rather than picking it from the list.
export const SLASH = [
  { cmd: 'meet', alone: true, hint: '/meet', what: 'start a video meeting and share it here' },
  { cmd: 'poll', hint: '/poll Question | option | option', what: 'ask a question with options' },
  { cmd: 'task', hint: '/task what to do', what: 'add a task to your list (with a link to here)' },
  { cmd: 'status', alone: true, hint: '/status 🍔 Lunch 1h', what: 'set your status (/status alone clears it)' },
];

// A leading emoji (with skin tones, joiners and variation selectors), and how long a status lasts.
const EMOJI = /^(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*)\s*/u;
const LASTS = /\s+(?:for\s+)?(?:(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?)|(today|(?:this\s+)?week))$/i;

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
