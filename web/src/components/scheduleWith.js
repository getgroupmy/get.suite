// Schedule a meeting with people (a colleague's card, a conversation in Chat): a new event with them invited, at the
// first half hour all of you are free within working hours (Find a time's suggestion), opened in Calendar to change
// and save. Without a suggestion, the next full hour.
import { get } from '../api.js';

export async function scheduleWith(people, { navigate, toast, title = '' }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let slot = null;
  if (people.length) {
    try { slot = (await get(`/freebusy/suggest?users=${people.map((p) => p.id).join(',')}&duration=30&tz=${encodeURIComponent(tz)}`)).slots?.[0] || null; } catch { /* the next hour */ }
  }
  const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() + 1);
  const start = slot?.start ?? t.getTime();
  navigate('/calendar', { state: { newEvent: { title, start, end: slot?.end ?? start + 30 * 60e3, all_day: 0, location: '', description: '', guests: people.map((p) => ({ email: p.email, name: p.name })) } } });
  if (slot) toast(`The first half hour ${people.length > 1 ? 'you’re all' : 'you’re both'} free: ${new Date(start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`);
}
