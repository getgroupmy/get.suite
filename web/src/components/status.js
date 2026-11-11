// Your status (an emoji and a few words colleagues see), and when it clears by itself.

export const PRESETS = [
  ['📅', 'In a meeting', '1h'], ['🚗', 'Commuting', '30m'], ['🤒', 'Out sick', 'today'],
  ['🌴', 'On holiday', 'week'], ['🏠', 'Working from home', 'today'], ['🎯', 'Focusing', '4h'],
];
export const CLEAR_AFTER = [['', 'Don’t clear'], ['30m', '30 minutes'], ['1h', '1 hour'], ['4h', '4 hours'], ['today', 'Today'], ['week', 'This week']];

/** When a "clear after" choice ends, from now (ms), or null for never. "today" is midnight; "week" the end of Sunday. */
export function untilFor(choice, now = new Date()) {
  const t = new Date(now);
  switch (choice) {
    case '30m': return t.getTime() + 30 * 60e3;
    case '1h': return t.getTime() + 60 * 60e3;
    case '4h': return t.getTime() + 4 * 60 * 60e3;
    case 'today': return new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime();
    case 'week': return new Date(t.getFullYear(), t.getMonth(), t.getDate() + (7 - t.getDay()) % 7 + 1).getTime();
    default: return null;
  }
}

/** "until 3:30 PM", "until tomorrow", "until Mon 10 Nov" — or '' when it doesn't clear. */
export function untilText(until, now = new Date()) {
  if (!until) return '';
  const d = new Date(until);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 864e5);
  // Midnight counts as the end of the day before.
  if (d.getHours() === 0 && d.getMinutes() === 0) return days === 1 ? 'until the end of today' : `until the end of ${new Date(until - 1).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`;
  if (days === 0) return `until ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return `until ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

/** The words for a status: "🌴 On holiday". */
export const statusLine = (s, now = new Date()) => {
  if (!s) return '';
  const words = [s.emoji, s.text].filter(Boolean).join(' ');
  return s.auto && s.until ? `${words} ${untilText(s.until, now)}` : words; // from the calendar: "📅 In a meeting until 15:00"
};

/** "Kim has notifications off until 4:30 PM: they may not see your call" for each person rung who won't hear it. */
export const unreachableText = (list = []) => list.map((u) => `${u.name} has notifications off until ${new Date(u.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: they may not see your call`).join('. ');
