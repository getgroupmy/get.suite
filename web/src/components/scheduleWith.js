// Schedule a meeting with people (a colleague's card, a conversation in Chat): a new event with them invited, at the
// first half hour all of you are free within working hours (Find a time's suggestion), opened in Calendar to change
// and save. Without a suggestion, the next full hour.
import { get } from '../api.js';

export async function scheduleWith(people, { navigate, toast, title = '', fromChat = null }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let slot = null;
  if (people.length) {
    try { slot = (await get(`/freebusy/suggest?users=${people.map((p) => p.id).join(',')}&duration=30&tz=${encodeURIComponent(tz)}`)).slots?.[0] || null; } catch { /* the next hour */ }
  }
  const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1);
  const start = slot?.start ?? t.getTime();
  navigate('/calendar', { state: { newEvent: { title, start, end: slot?.end ?? start + 30 * 60e3, all_day: 0, location: '', description: '', guests: people.map((p) => ({ email: p.email, name: p.name })), ...(fromChat && { from_chat: fromChat }) } } });
  if (slot) toast(`The first half hour ${people.length > 1 ? 'you’re all' : 'you’re both'} free: ${new Date(start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`);
}

/**
 * A new event moved to the first time (of its length) when you and the colleagues among its guests are all free;
 * people outside the company can't be checked. Unchanged when nobody can be checked or nothing is found.
 */
export async function withFreeTime(ev) {
  try {
    const directory = await get('/users/directory');
    const ids = (ev.guests || []).map((g) => directory.find((d) => d.username.toLowerCase() === String(g.email).toLowerCase())?.id).filter(Boolean);
    if (!ids.length) return { ev, moved: false };
    const minutes = Math.max(15, Math.round((ev.end - ev.start) / 60e3));
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const slot = (await get(`/freebusy/suggest?users=${ids.join(',')}&duration=${minutes}&tz=${encodeURIComponent(tz)}`)).slots?.[0];
    return slot ? { ev: { ...ev, start: slot.start, end: slot.end }, moved: true } : { ev, moved: false };
  } catch { return { ev, moved: false }; }
}
