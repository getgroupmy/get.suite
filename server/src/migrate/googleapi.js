// Google Calendar and Google Contacts read through Google's APIs (with the access a person gives when
// they sign in at Google: googleimport.js), turned into an .ics and a vCard for the usual imports.
const API = () => (process.env.GOOGLE_API_URL || 'https://www.googleapis.com').replace(/\/$/, '');
const PEOPLE = () => (process.env.GOOGLE_PEOPLE_URL || 'https://people.googleapis.com').replace(/\/$/, '');

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
/** "2026-12-03T09:00:00+08:00" → "20261203T010000Z"; "2026-12-03" → "20261203". */
const icsTime = (t) => (t.date ? t.date.replace(/-/g, '') : new Date(t.dateTime).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));

/** One Google Calendar event (API JSON) as a VEVENT, or null for cancelled ones. */
export function eventToIcs(e) {
  if (!e || e.status === 'cancelled' || !e.start || !e.end) return null;
  const allDay = !!e.start.date;
  const lines = ['BEGIN:VEVENT', `UID:${e.iCalUID || `${e.id}@google.com`}`, `SUMMARY:${esc(e.summary || '(No title)')}`,
    allDay ? `DTSTART;VALUE=DATE:${icsTime(e.start)}` : e.start.timeZone ? `DTSTART;TZID=${e.start.timeZone}:${localIcs(e.start)}` : `DTSTART:${icsTime(e.start)}`,
    allDay ? `DTEND;VALUE=DATE:${icsTime(e.end)}` : e.end.timeZone ? `DTEND;TZID=${e.end.timeZone}:${localIcs(e.end)}` : `DTEND:${icsTime(e.end)}`];
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.description) lines.push(`DESCRIPTION:${esc(String(e.description).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))}`);
  for (const r of e.recurrence || []) if (/^(RRULE|EXDATE|RDATE)[:;]/.test(r)) lines.push(r);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}
/** A repeating event's start written in its own zone (so repeats keep their time across clock changes). */
function localIcs(t) {
  const d = new Date(t.dateTime);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: t.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}
export const calendarIcs = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workspace//Google import//EN', ...events.map(eventToIcs).filter(Boolean), 'END:VCALENDAR'].join('\r\n');

/** One Google contact (People API JSON) as a vCard, or null when it has no name, address or number. */
export function personToVcard(p) {
  const name = p.names?.[0]?.displayName || p.organizations?.[0]?.name || p.emailAddresses?.[0]?.value;
  if (!name) return null;
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(name)}`];
  const n = p.names?.[0];
  if (n) lines.push(`N:${esc(n.familyName || '')};${esc(n.givenName || '')};;;`);
  for (const e of p.emailAddresses || []) if (e.value) lines.push(`EMAIL;TYPE=${String(e.type || 'other').toUpperCase()}:${e.value}`);
  for (const t of p.phoneNumbers || []) if (t.value) lines.push(`TEL;TYPE=${String(t.type || 'other').toUpperCase()}:${t.value}`);
  const o = p.organizations?.[0];
  if (o?.name) lines.push(`ORG:${esc(o.name)}`);
  if (o?.title) lines.push(`TITLE:${esc(o.title)}`);
  const a = p.addresses?.[0];
  if (a?.formattedValue) lines.push(`ADR;TYPE=${String(a.type || 'home').toUpperCase()}:;;${esc(a.formattedValue.replace(/\n/g, ', '))};;;;`);
  const b = p.birthdays?.find((x) => x.date?.month && x.date?.day)?.date;
  if (b) lines.push(`BDAY:${b.year ? String(b.year).padStart(4, '0') : '--'}${String(b.month).padStart(2, '0')}${String(b.day).padStart(2, '0')}`);
  if (p.biographies?.[0]?.value) lines.push(`NOTE:${esc(p.biographies[0].value)}`);
  if (p.resourceName) lines.push(`UID:google-${p.resourceName.replace(/^people\//, '')}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

const getJson = async (url, token) => {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Google answered ${r.status}`), { status: r.status });
  return j;
};

/** The person's own calendars (not ones only shared to read), each with its events: [{ name, primary, events }]. */
export async function googleCalendars(token, { maxEvents = 20000 } = {}) {
  const list = await getJson(`${API()}/calendar/v3/users/me/calendarList?minAccessRole=owner&maxResults=250`, token);
  const out = [];
  let total = 0;
  for (const c of list.items || []) {
    const events = [];
    let page = null;
    do {
      const qs = new URLSearchParams({ maxResults: '2500', singleEvents: 'false', showDeleted: 'false', ...(page && { pageToken: page }) });
      const r = await getJson(`${API()}/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${qs}`, token);
      events.push(...(r.items || []));
      page = r.nextPageToken;
      total += (r.items || []).length;
    } while (page && total < maxEvents);
    out.push({ name: c.summaryOverride || c.summary || c.id, primary: !!c.primary, events });
  }
  return out;
}

/** The person's Google contacts (People API connections). */
export async function googleContacts(token, { max = 10000 } = {}) {
  const fields = 'names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies';
  const out = [];
  let page = null;
  do {
    const qs = new URLSearchParams({ personFields: fields, pageSize: '1000', ...(page && { pageToken: page }) });
    const r = await getJson(`${PEOPLE()}/v1/people/me/connections?${qs}`, token);
    out.push(...(r.connections || []));
    page = r.nextPageToken;
  } while (page && out.length < max);
  return out;
}
