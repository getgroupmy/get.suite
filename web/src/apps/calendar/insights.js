// Time insights: how a span of days was spent, from the (expanded) events in it.
// Meetings are events with other people (you invited guests, or you're a guest who didn't decline);
// focus is focus time; everything else timed is "other". All-day events, out of office, declined
// invitations, tasks and birthdays don't count.

const HOUR = 36e5;

/** { total, meetings, focus, other (hours), byDay: [{ day, meetings, focus, other }], people: [{ name, email, hours, count }] } */
export function insights(events, from, to, me) {
  const days = [];
  for (let d = new Date(from); d.getTime() < to; d.setDate(d.getDate() + 1)) days.push({ day: new Date(d).getTime(), meetings: 0, focus: 0, other: 0 });
  const people = new Map();
  const sums = { meetings: 0, focus: 0, other: 0 };
  for (const e of events) {
    if (e.all_day || e.task || e.birthday || e.kind === 'ooo' || (e.role === 'guest' && e.my_status === 'no')) continue;
    const start = Math.max(e.start, from), end = Math.min(e.end, to);
    if (end <= start) continue;
    const others = (e.guests || []).filter((g) => g.email !== me && g.status !== 'no');
    const withOrganizer = e.role === 'guest' && e.organizer ? [{ name: e.organizer.name, email: e.organizer.email }] : [];
    const kind = e.kind === 'focus' ? 'focus' : others.length || e.role === 'guest' ? 'meetings' : 'other';
    // Split across days.
    for (const d of days) {
      const ds = d.day, de = d.day + 864e5;
      const a = Math.max(start, ds), b = Math.min(end, de);
      if (b > a) d[kind] += (b - a) / HOUR;
    }
    sums[kind] += (end - start) / HOUR;
    if (kind === 'meetings') {
      for (const p of [...others, ...withOrganizer]) {
        if (!p.email || p.email === me) continue;
        const k = p.email.toLowerCase();
        const cur = people.get(k) || { name: p.name || p.email, email: p.email, hours: 0, count: 0 };
        cur.hours += (end - start) / HOUR; cur.count += 1;
        people.set(k, cur);
      }
    }
  }
  const round = (x) => Math.round(x * 10) / 10;
  return {
    total: round(sums.meetings + sums.focus + sums.other), meetings: round(sums.meetings), focus: round(sums.focus), other: round(sums.other),
    byDay: days.map((d) => ({ day: d.day, meetings: round(d.meetings), focus: round(d.focus), other: round(d.other) })),
    people: [...people.values()].sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name)).slice(0, 5).map((p) => ({ ...p, hours: round(p.hours) })),
  };
}

/** "1.5 h", "45 min", "0 h". */
export const hoursText = (h) => (h > 0 && h < 1 ? `${Math.round(h * 60)} min` : `${h} h`);
