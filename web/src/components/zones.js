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
