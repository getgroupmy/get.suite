// Reminder times for notes: the quick choices, and how a reminder reads on a card.

const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };

/** [label, time] choices from `now`: later today (if before 5pm), tomorrow morning, next Monday morning. */
export function quickTimes(now = new Date()) {
  const out = [];
  if (now.getHours() < 17) out.push(['Later today', at(now, 18)]);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  out.push(['Tomorrow', at(tomorrow, 8)]);
  const monday = new Date(now); monday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7));
  out.push(['Next week', at(monday, 8)]);
  return out;
}

/** "Today, 18:00", "Tomorrow, 08:00", "Mon 9 Nov, 08:00"; past ones say so. */
export function reminderText(ms, now = new Date()) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 864e5);
  const when = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${when}, ${time}`;
}
