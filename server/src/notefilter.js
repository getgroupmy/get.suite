// Notes search by kind and colour, as in Google Keep: lists, pictures (drawings are pictures too),
// voice recordings, links and reminders, and a card colour (or "none" for the default).

export const NOTE_TYPES = ['list', 'picture', 'voice', 'link', 'reminder', 'daily', 'comment']; // daily: Today's notes, past and present; comment: with comments
const LINK = /\bhttps?:\/\/\S/i;

/** Whether a shaped note (items, pictures, recordings, body, remind_at, color, comments) is of this kind and colour. */
export function noteFits(n, { type, color } = {}) {
  if (type === 'list' && !n.items) return false;
  if (type === 'picture' && !n.pictures?.length) return false;
  if (type === 'voice' && !n.recordings?.length) return false;
  if (type === 'reminder' && !n.remind_at) return false;
  if (type === 'daily' && !n.daily_date) return false;
  if (type === 'comment' && !(n.comments > 0)) return false;
  if (type === 'link' && !LINK.test(`${n.title} ${n.body} ${(n.items || []).map((i) => i.text).join(' ')}`)) return false;
  if (color === 'none' && n.color) return false;
  if (color && color !== 'none' && String(n.color || '').toLowerCase() !== color.toLowerCase()) return false;
  return true;
}

/** { type, color } from a request's query, or { error }. */
export function noteFilterOf(query) {
  const type = query.type ? String(query.type) : null;
  const color = query.color ? String(query.color) : null;
  if (type && !NOTE_TYPES.includes(type)) return { error: `type can be ${NOTE_TYPES.join(', ')}` };
  if (color && color !== 'none' && !/^#[0-9a-f]{6}$/i.test(color)) return { error: 'color is a colour like #fff8b8, or none' };
  return { type, color };
}
