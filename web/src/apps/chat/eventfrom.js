// Chat's /event: the words after it read as Calendar's quick add ("Planning friday 3pm for 30m", "@kim",
// "in the Boardroom"), with who's invited coming from the conversation: everyone in a direct message or a
// private channel (up to 20), and in an open channel only the people named with @.
import { parseQuickEvent } from '../calendar/quickevent.js';

export const MAX_GUESTS = 20;

/**
 * The new event for Calendar to open, or { error }. `members` and `directory` are [{ id, username, name }];
 * `channel` is { id, name, dm_key, private }; `me` is { id, username }. When the words name no day or time,
 * `findTime` is true: the caller moves it to the first time everyone is free (as the 📅 button does).
 */
export function eventFromChat(text, { channel, members = [], directory = [], rooms = [], me, today, minutes = 30 }) {
  const others = members.filter((m) => m.id !== me.id && !m.disabled); // a turned-off account can't be invited
  const everyone = channel.dm_key || channel.private;
  const people = directory.filter((p) => p.id !== me.id);
  const words = String(text || '').trim();
  const q = words ? parseQuickEvent(words, { today, minutes, people, rooms }) : null;
  const named = q?.guests || [];
  const fromHere = everyone ? others.map((m) => m.username.toLowerCase()) : [];
  const guests = [...new Set([...fromHere, ...named])];
  if (guests.length > MAX_GUESTS) return { error: `At most ${MAX_GUESTS} people: invite them from Calendar instead` };
  const nameOf = (email) => [...members, ...directory].find((p) => p.username.toLowerCase() === email)?.name;
  const title = q ? q.title : words || (channel.dm_key ? '' : channel.name || '');
  const ev = {
    title, location: '', description: '', from_chat: channel.id,
    guests: guests.map((email) => ({ email, ...(nameOf(email) && { name: nameOf(email) }) })),
    ...(q ? { start: q.start, end: q.end, all_day: q.all_day } : {}),
    ...(q?.rrule && { rrule: q.rrule }),
    ...(q?.rooms?.length && { pick_rooms: q.rooms }),
  };
  return { ev, findTime: !q };
}
