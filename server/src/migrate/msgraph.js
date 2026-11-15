// Microsoft 365 / Outlook.com read through Microsoft Graph (with the access a person gives by signing in
// with a code: msimport.js): calendars and contacts turned into an .ics and vCards for the usual imports,
// and OneDrive walked folder by folder, each file streamed from its download address.
import { Readable } from 'node:stream';

const GRAPH = () => (process.env.MS_GRAPH_URL || 'https://graph.microsoft.com').replace(/\/$/, '');
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
const DAYS = { sunday: 'SU', monday: 'MO', tuesday: 'TU', wednesday: 'WE', thursday: 'TH', friday: 'FR', saturday: 'SA' };
const INDEX = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/** "2026-12-03T09:00:00.0000000" in UTC (asked for with Prefer: outlook.timezone="UTC") → "20261203T090000Z". */
const utc = (t) => `${String(t).slice(0, 19).replace(/[-:]/g, '')}Z`;
const dateOnly = (t) => String(t).slice(0, 10).replace(/-/g, '');

/** Graph's recurrence (pattern and range) as an RRULE, or null for one it doesn't describe. */
export function rruleOf(rec) {
  const p = rec?.pattern, r = rec?.range;
  if (!p) return null;
  const parts = [];
  const freq = { daily: 'DAILY', weekly: 'WEEKLY', absoluteMonthly: 'MONTHLY', relativeMonthly: 'MONTHLY', absoluteYearly: 'YEARLY', relativeYearly: 'YEARLY' }[p.type];
  if (!freq) return null;
  parts.push(`FREQ=${freq}`);
  if (p.interval > 1) parts.push(`INTERVAL=${p.interval}`);
  const days = (p.daysOfWeek || []).map((d) => DAYS[String(d).toLowerCase()]).filter(Boolean);
  if (p.type === 'weekly' && days.length) parts.push(`BYDAY=${days.join(',')}`);
  if (/^relative/.test(p.type) && days.length) parts.push(`BYDAY=${INDEX[p.index] || 1}${days[0]}`);
  if (/^absolute/.test(p.type) && p.dayOfMonth) parts.push(`BYMONTHDAY=${p.dayOfMonth}`);
  if (/Yearly$/.test(p.type) && p.month) parts.push(`BYMONTH=${p.month}`);
  if (r?.type === 'endDate' && r.endDate) parts.push(`UNTIL=${r.endDate.replace(/-/g, '')}T235959Z`);
  if (r?.type === 'numbered' && r.numberOfOccurrences) parts.push(`COUNT=${r.numberOfOccurrences}`);
  return `RRULE:${parts.join(';')}`;
}

/** One Graph event as a VEVENT (series and single events; cancelled ones and occurrences left out). */
export function graphEventToIcs(e) {
  if (!e || e.isCancelled || !e.start || !e.end || e.type === 'occurrence' || e.type === 'exception') return null;
  const lines = ['BEGIN:VEVENT', `UID:${e.iCalUId || `${e.id}@outlook.com`}`, `SUMMARY:${esc(e.subject || '(No title)')}`];
  if (e.isAllDay) lines.push(`DTSTART;VALUE=DATE:${dateOnly(e.start.dateTime)}`, `DTEND;VALUE=DATE:${dateOnly(e.end.dateTime)}`);
  else lines.push(`DTSTART:${utc(e.start.dateTime)}`, `DTEND:${utc(e.end.dateTime)}`);
  if (e.location?.displayName) lines.push(`LOCATION:${esc(e.location.displayName)}`);
  const body = e.body?.contentType === 'html' ? String(e.body.content || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : String(e.body?.content || '').trim();
  if (body) lines.push(`DESCRIPTION:${esc(body.slice(0, 5000))}`);
  const rr = e.type === 'seriesMaster' ? rruleOf(e.recurrence) : null;
  if (rr) lines.push(rr);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}
export const graphCalendarIcs = (events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Workspace//Microsoft import//EN', ...events.map(graphEventToIcs).filter(Boolean), 'END:VCALENDAR'].join('\r\n');

/** One Outlook contact as a vCard, or null with nothing to call it. */
export function graphContactToVcard(c) {
  const name = c.displayName || [c.givenName, c.surname].filter(Boolean).join(' ') || c.companyName || c.emailAddresses?.[0]?.address;
  if (!name) return null;
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(name)}`, `N:${esc(c.surname || '')};${esc(c.givenName || '')};;;`];
  for (const e of c.emailAddresses || []) if (e.address) lines.push(`EMAIL:${e.address}`);
  if (c.mobilePhone) lines.push(`TEL;TYPE=CELL:${c.mobilePhone}`);
  for (const t of c.businessPhones || []) lines.push(`TEL;TYPE=WORK:${t}`);
  for (const t of c.homePhones || []) lines.push(`TEL;TYPE=HOME:${t}`);
  if (c.companyName) lines.push(`ORG:${esc(c.companyName)}`);
  if (c.jobTitle) lines.push(`TITLE:${esc(c.jobTitle)}`);
  if (c.birthday) lines.push(`BDAY:${String(c.birthday).slice(0, 10)}`);
  if (c.personalNotes) lines.push(`NOTE:${esc(c.personalNotes)}`);
  if (c.id) lines.push(`UID:outlook-${c.id}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

const getJson = async (url, token) => {
  const r = await fetch(url.startsWith('http') ? url : `${GRAPH()}${url}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', prefer: 'outlook.timezone="UTC"' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Microsoft answered ${r.status}`), { status: r.status });
  return j;
};
/** Every page of a Graph list. */
async function all(url, token, max = 20000) {
  const out = [];
  let next = url;
  while (next && out.length < max) { const j = await getJson(next, token); out.push(...(j.value || [])); next = j['@odata.nextLink'] || null; }
  return out;
}

/** The person's calendars, each with its events (series as series): [{ name, primary, events }]. */
export async function msCalendars(token) {
  const cals = await all('/v1.0/me/calendars?$top=100', token);
  const out = [];
  for (const c of cals) {
    const events = await all(`/v1.0/me/calendars/${encodeURIComponent(c.id)}/events?$top=500&$select=subject,body,start,end,location,isAllDay,recurrence,iCalUId,type,isCancelled`, token);
    out.push({ name: c.name, primary: !!c.isDefaultCalendar, events });
  }
  return out;
}
export const msContacts = (token) => all('/v1.0/me/contacts?$top=500', token);

/**
 * OneDrive's files, folder by folder: [{ path, dir, size, stream() }] (stream reads the file from its
 * download address when asked, one at a time). Up to `max` items.
 */
export async function msDriveItems(token, { max = 20000 } = {}) {
  const out = [];
  const walk = async (url, prefix) => {
    for (const it of await all(url, token)) {
      if (out.length >= max) return;
      const name = String(it.name || 'untitled').replace(/[\\/]/g, '_');
      const path = prefix ? `${prefix}/${name}` : name;
      if (it.folder) { out.push({ path, dir: true }); await walk(`/v1.0/me/drive/items/${encodeURIComponent(it.id)}/children?$top=200`, path); continue; }
      if (!it.file) continue; // OneNote notebooks and the like
      const dl = it['@microsoft.graph.downloadUrl'];
      out.push({
        path, dir: false, size: it.size || 0,
        stream: () => {
          const s = new Readable({ read() {} });
          (async () => {
            const r = dl ? await fetch(dl) : await fetch(`${GRAPH()}/v1.0/me/drive/items/${encodeURIComponent(it.id)}/content`, { headers: { authorization: `Bearer ${token}` } });
            if (!r.ok) { s.destroy(new Error(`Couldn’t download ${path} (${r.status})`)); return; }
            for await (const chunk of r.body) s.push(Buffer.from(chunk));
            s.push(null);
          })().catch((e) => s.destroy(e));
          return s;
        },
      });
    }
  };
  await walk('/v1.0/me/drive/root/children?$top=200', '');
  return out;
}
