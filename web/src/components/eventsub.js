// What an event says under its title in search results: when (today, tomorrow, a weekday this week, else the date),
// where, 🔁 when it repeats, and your answer when you haven't said yes (as a guest). Times in your own time zone.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ANSWER = { needs: 'not answered yet', maybe: 'you said maybe', no: 'you said no' };

const midnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today 15:00", "Tomorrow, all day", "Fri 28 Nov 09:30", "3 Jan 2027 10:00", "Yesterday 18:00". */
export function eventWhen(start, allDay, now = Date.now()) {
  const d = new Date(start);
  const days = Math.round((midnight(start) - midnight(now)) / 864e5);
  const time = allDay ? ', all day' : ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''}`;
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : days > 1 && days < 7 ? `${DAYS[d.getDay()]} ${date}` : date;
  return `${day}${time}`;
}

export function eventSub(e, now = Date.now()) {
  return [eventWhen(e.start, e.all_day, now), e.location, e.repeats ? '🔁' : null, e.role === 'guest' && e.upcoming !== false ? ANSWER[e.my_status] : null]
    .filter(Boolean).join(' · ');
}
