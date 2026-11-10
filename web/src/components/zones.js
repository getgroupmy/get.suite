// Time zones for the Calendar's second column of hours.

/** All the zones the browser knows (falls back to a short list). */
export function allZones() {
  try { if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone'); } catch { /* old browser */ }
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
}

/** The time at `ms` in a zone, as the hour labels show it: "5 PM", or "2:30 PM" off the hour. */
export function timeIn(ms, tz) {
  const opts = { timeZone: tz, hour: 'numeric', minute: '2-digit' };
  const parts = new Intl.DateTimeFormat([], opts).formatToParts(new Date(ms));
  const minute = parts.find((p) => p.type === 'minute')?.value;
  return minute === '00' ? new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric' }).format(new Date(ms)) : new Intl.DateTimeFormat([], opts).format(new Date(ms));
}

/** A short name for a zone at a moment: "GMT+5:30", "EST", "CET"… */
export function zoneName(tz, ms = Date.now()) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value || tz; }
  catch { return tz; }
}

/** "Asia/Kuala_Lumpur" → "Kuala Lumpur". */
export const cityOf = (tz) => String(tz).split('/').pop().replace(/_/g, ' ');

/** The minutes a zone is ahead of UTC at `ms`. */
export function offsetMinutes(tz, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

/** A world clock's line: { city, time: "3:05 PM", day: 'tomorrow' | 'yesterday' | '', diff: "+8 h" / "−5:30 h" / "same time" }. */
export function clockLine(tz, ms = Date.now(), home = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const time = new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  const dayOf = (z) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  const there = dayOf(tz), here = dayOf(home);
  const day = there > here ? 'tomorrow' : there < here ? 'yesterday' : '';
  const d = offsetMinutes(tz, ms) - offsetMinutes(home, ms);
  const h = Math.floor(Math.abs(d) / 60), m = Math.abs(d) % 60;
  const diff = d === 0 ? 'same time' : `${d > 0 ? '+' : '−'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''} h`;
  return { city: cityOf(tz), time, day, diff };
}
