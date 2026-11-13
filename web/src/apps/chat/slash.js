// Slash commands typed at the start of the message box: /meet, /poll Question | option | option, /task title.
export const SLASH = [
  { cmd: 'meet', hint: '/meet', what: 'start a video meeting and share it here' },
  { cmd: 'poll', hint: '/poll Question | option | option', what: 'ask a question with options' },
  { cmd: 'task', hint: '/task what to do', what: 'add a task to your list (with a link to here)' },
];

/** What a message box's text asks for: null when it isn't a command (plain text, or an unknown /word sent as is). */
export function parseSlash(text) {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  if (cmd === 'meet') return { cmd };
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
