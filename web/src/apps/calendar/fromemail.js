// "Create event" on an email: a new event with its subject, everyone on it as guests (but you), and its text.
const MAX_DESCRIPTION = 4000;

/**
 * The event to start from: the next half hour, an hour long. `mine` is your own addresses (lower case),
 * left out of the guests; `now` is a timestamp.
 */
export function eventFromEmail(m, mine, now = Date.now()) {
  const own = new Set(mine.map((a) => a.toLowerCase()));
  const guests = [];
  for (const a of [m.from, ...(m.to || []), ...(m.cc || [])]) {
    const e = a?.address?.toLowerCase();
    if (e && !own.has(e) && !guests.includes(e)) guests.push(e);
  }
  const subject = String(m.subject || '').replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, '').trim();
  let text = String(m.text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > MAX_DESCRIPTION) text = `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
  const start = Math.ceil(now / 18e5) * 18e5;
  return { title: subject, start, end: start + 36e5, all_day: 0, location: '', description: text, guests: guests.map((email) => ({ email })) };
}
