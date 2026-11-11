// Birthday and date reminders (Contacts → Reminders): on the morning (from 9:00 in your time zone) of a
// contact's birthday, or of another date on a contact (an anniversary…), or the day before, a notification
// in the bell (and on phones with notifications on). One a day at most, naming everyone whose day it is.
import { q } from './db.js';
import { zoneOrUtc } from './ics.js';
import { birthdaysBetween } from './birthday.js';
import { datesBetween } from './contactfields.js';
import { notify } from './notifications.js';

q(`CREATE TABLE IF NOT EXISTS contact_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sort TEXT NOT NULL DEFAULT 'first'
)`).run(); // (made here too: this can load before Contacts does)
for (const [col, type] of [['remind', 'TEXT'], ['remind_tz', 'TEXT'], ['remind_last', 'TEXT']]) {
  if (!q('PRAGMA table_info(contact_prefs)').all().some((c) => c.name === col)) q(`ALTER TABLE contact_prefs ADD COLUMN ${col} ${type}`).run();
}
export const REMIND = ['day', 'before']; // on the day, or the day before
export const REMIND_HOUR = 9;

/** The date (YYYY-MM-DD) and hour it is at t in a time zone. */
function localNow(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Whose day it is (YYYY-MM-DD) among someone's contacts: [{ name, what, years }] — birthdays first. */
export function datesOn(userId, date) {
  const out = [];
  for (const c of q('SELECT name, birthday, dates FROM contacts WHERE owner_id = ? AND (birthday IS NOT NULL OR dates IS NOT NULL)').all(userId)) {
    for (const b of birthdaysBetween(c.birthday, date, date)) out.push({ name: c.name, what: 'birthday', years: b.age });
    let list = []; try { list = JSON.parse(c.dates || '[]'); } catch { list = []; }
    for (const d of datesBetween(list, date, date, birthdaysBetween)) out.push({ name: c.name, what: d.label || 'date', years: d.years });
  }
  return out.sort((a, b) => (a.what !== 'birthday') - (b.what !== 'birthday') || a.name.localeCompare(b.name));
}

/** The notification's words: "Ada Lovelace's birthday (36)", "and 2 more". */
export function reminderText(list, when) {
  const one = (x) => (x.what === 'birthday' ? `${x.name}’s birthday${x.years ? ` (${x.years})` : ''}` : `${x.name}: ${x.what}${x.years ? ` (${x.years} years)` : ''}`);
  const head = `${when === 'before' ? '🎂 Tomorrow' : '🎂 Today'}: ${one(list[0])}`;
  return { title: list.length > 1 ? `${head} and ${list.length - 1} more` : head, body: list.map(one).join(' · ') };
}

/** Run now and then: tells everyone due a reminder whose morning has come. Returns how many were told. */
export function sendDateReminders(t = Date.now()) {
  let n = 0;
  for (const p of q('SELECT user_id, remind, remind_tz, remind_last FROM contact_prefs WHERE remind IS NOT NULL').all()) {
    const { date, hour } = localNow(t, zoneOrUtc(p.remind_tz || 'UTC'));
    if (hour < REMIND_HOUR || p.remind_last === date) continue;
    q('UPDATE contact_prefs SET remind_last = ? WHERE user_id = ?').run(date, p.user_id);
    const day = p.remind === 'before' ? addDays(date, 1) : date;
    const list = datesOn(p.user_id, day);
    if (!list.length) continue;
    const text = reminderText(list, p.remind);
    notify([p.user_id], { kind: 'dates', ...text, link: list.length === 1 ? `/contacts?q=${encodeURIComponent(list[0].name)}` : '/contacts' });
    n++;
  }
  return n;
}
