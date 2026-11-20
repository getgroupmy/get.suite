// Repeating events on the server: an all-day event runs midnight to midnight in the zone it was made in (its tz), not on
// this server's clock — a Monday in Kuala Lumpur starts at 16:00 on Sunday UTC, and worked out in UTC its weekly
// repeats would land on Tuesdays (in the daily agenda, reminders, booking pages and rooms).
import { expand as expandSeen } from './calmath.js';

export const expand = (ev, from, to) => {
  if (!ev.all_day || !ev.tz || ev.dayZone) return expandSeen(ev, from, to);
  return expandSeen({ ...ev, dayZone: ev.tz }, from, to).map((o) => { const out = { ...o }; delete out.dayZone; return out; });
};
