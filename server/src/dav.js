// Phone sync: CalDAV (calendar) and CardDAV (contacts), the standards that iPhones, Android
// (with DAVx5), Thunderbird and macOS use. Mounted at /dav, with /.well-known/caldav and
// /.well-known/carddav pointing there so apps find it from just the server name.
//
//   /dav/                              who am I (current-user-principal)
//   /dav/principals/<user>/            my calendar home and address book home
//   /dav/calendars/<user>/default/     my events, one .ics each (and invitations)
//   /dav/calendars/<user>/<id>/        each calendar of my own (Personal, a project…), its events
//   /dav/addressbooks/<user>/default/  my contacts, one .vcf each
//
// Signing in: email address and password over HTTPS (Basic). With two-step verification on, only
// the mail-app password works here, so a phone never gets around the second step. Wrong passwords
// count towards sign-in protection like any other sign-in.
import { trashContact } from './contacttrash.js';
import express, { Router } from 'express';
import crypto from 'node:crypto';
import { q } from './db.js';
import { uid, now, HttpError } from './util.js';
import { verifyPassword } from './auth.js';
import { verifyDovecotHash } from './mail/crypt.js';
import * as guard from './security/guard.js';
import * as twoFactor from './twofactor.js';
import { buildIcs, parseIcsEvent, zoneOrUtc, contentLines } from './ics.js';
import { remindersOf, setReminders } from './reminders.js';
import { buildVcard, parseVcard } from './vcard.js';
import { withPhoto, photoFromCard } from './contactphotos.js';
import { MAIL_HOSTNAME } from './mail/config.js';
import { sendTo } from './hub.js';
import { notify as bell } from './notifications.js';
import { peopleOf } from './mycalendars.js';
import { markActive } from './activedays.js';

const NS = 'xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const etagOf = (body) => `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 24)}"`;
const MAX_BODY = '4mb';

// ---- signing in ----
export function authenticate(req) {
  const m = /^Basic\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const login = decoded.slice(0, i).trim().toLowerCase(), password = decoded.slice(i + 1);
  const verdict = guard.check(req.ip, login);
  if (verdict.action === 'reject') throw new HttpError(429, 'Too many failed sign-ins');
  const u = q('SELECT id, username, name, password_hash, mail_app_hash, disabled, org_id FROM users WHERE username = ?').get(login);
  // A mail-app password always works; the account password only without two-step verification.
  const ok = u && !u.disabled && ((u.mail_app_hash && verifyDovecotHash(password, u.mail_app_hash))
    || (!twoFactor.isEnabled(u.id) && verifyPassword(password, u.password_hash)));
  if (!ok) {
    guard.recordFailure({ ip: req.ip, login, fp: guard.passwordFingerprint(password), service: 'dav' });
    return null;
  }
  // A phone or Outlook syncing counts as using the account (at most every 5 minutes).
  if (q('UPDATE users SET last_active = ? WHERE id = ? AND (last_active IS NULL OR last_active < ?)').run(now(), u.id, now() - 5 * 60e3).changes) markActive(u.id);
  return u;
}

// ---- responses ----
const multistatus = (responses) => `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${NS}>\n${responses.join('\n')}\n</d:multistatus>`;
function response(href, props, missing = []) {
  const ok = Object.entries(props).filter(([, v]) => v !== undefined).map(([k, v]) => (v === '' ? `<${k}/>` : `<${k}>${v}</${k}>`)).join('');
  const notFound = missing.length ? `<d:propstat><d:prop>${missing.map((k) => `<${k}/>`).join('')}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>` : '';
  return `<d:response><d:href>${esc(href)}</d:href><d:propstat><d:prop>${ok}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>${notFound}</d:response>`;
}
const notFoundResponse = (href) => `<d:response><d:href>${esc(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;

/** The properties a request asks for, as "prefix:name" in our namespaces (null: all). */
function requested(body) {
  const xml = String(body || '');
  if (!xml.trim() || /<(?:\w+:)?allprop\b/.test(xml)) return null;
  const prop = /<(?:\w+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?prop>/.exec(xml);
  if (!prop) return null;
  // Map each element's namespace (declared with any prefix) to ours.
  const nsMap = {};
  for (const [, p, uri] of xml.matchAll(/xmlns(?::(\w+))?="([^"]+)"/g)) nsMap[p || ''] = uri;
  const ours = { 'DAV:': 'd', 'urn:ietf:params:xml:ns:caldav': 'cal', 'urn:ietf:params:xml:ns:carddav': 'card', 'http://calendarserver.org/ns/': 'cs', 'http://apple.com/ns/ical/': 'ic' };
  return [...prop[1].matchAll(/<(?:(\w+):)?([\w-]+)(?:\s[^>]*?)?\/?>/g)].map(([, p, name]) => `${ours[nsMap[p || '']] || 'x'}:${name}`);
}
/** Keep only the asked-for properties; the rest asked for but unknown are reported as missing. */
function pick(all, want) {
  if (!want) return [all, []];
  const out = {}, missing = [];
  for (const k of want) { if (k in all) out[k] = all[k]; else missing.push(k.startsWith('x:') ? `d:${k.slice(2)}` : k); }
  return [out, missing.filter((k) => !k.startsWith('x:'))];
}
const hrefsIn = (body) => [...String(body || '').matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)].map((m) => decodeURIComponent(m[1].trim()));

// ---- what's stored ----
const host = () => MAIL_HOSTNAME || 'workspace';
// A calendar's events (changed single occurrences travel inside their series): the main one ("default",
// calId null) has your events in no other calendar and invitations you haven't declined; each calendar of
// your own (Personal, a project…) is a calendar of its own on the phone, with just its events.
const eventsOf = (userId, calId = null) => (calId
  ? q(`SELECT e.*, NULL AS my_status, ? AS for_user FROM events e WHERE e.owner_id = ? AND e.calendar_id = ?
       AND (e.recur_parent IS NULL OR NOT EXISTS (SELECT 1 FROM events p WHERE p.id = e.recur_parent AND p.rrule IS NOT NULL)) ORDER BY start`).all(userId, userId, calId)
  : q(`SELECT e.*, NULL AS my_status, ? AS for_user FROM events e WHERE e.owner_id = ? AND e.calendar_id IS NULL
    AND (e.recur_parent IS NULL OR NOT EXISTS (SELECT 1 FROM events p WHERE p.id = e.recur_parent AND p.rrule IS NOT NULL))
  UNION ALL SELECT e.*, g.status AS my_status, ? AS for_user FROM events e JOIN event_guests g ON g.event_id = e.id WHERE g.user_id = ? AND g.status != 'no'
  ORDER BY start`).all(userId, userId, userId, userId));
const ownCalendars = (userId) => q('SELECT * FROM user_calendars WHERE owner_id = ? ORDER BY created_at, name').all(userId);
// Calendars colleagues share with you: on the phone too, read-only unless you may make changes.
const SHARED = `SELECT c.*, 1 AS shared, s.can_edit, u.name AS owner_name FROM user_calendar_shares s JOIN user_calendars c ON c.id = s.calendar_id
  JOIN users u ON u.id = c.owner_id WHERE s.user_id = ? AND u.disabled = 0`;
const sharedCalendars = (userId) => q(`${SHARED} ORDER BY c.name`).all(userId);
const readOnly = (cal) => !!cal?.shared && !cal.can_edit;
// Shared with you to look at: a private event is only "Busy" on your phone too.
const maskRow = (e) => (e?.private ? { ...e, title: 'Busy', description: null, location: null, meet_code: null, attachments: null } : e);
const viewOf = (cal, rows) => (readOnly(cal) ? rows.map(maskRow) : rows);
const collOf = (calId) => calId || 'default';
const contactsOf = (userId) => q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name').all(userId);
const eventName = (e) => e.dav_name || `${e.id}.ics`;
const contactName = (c) => c.dav_name || `${c.id}.vcf`;
const outEvent = (e) => ({ ...e, rrule: e.rrule ? JSON.parse(e.rrule) : null, exdates: JSON.parse(e.exdates || '[]') });
// DTSTAMP is fixed so the same event always gives the same file (and ETag); a changing timestamp
// would make every phone think the event changed elsewhere.
const STAMP = Date.UTC(2000, 0, 1);
export function icsOf(e) {
  const overrides = e.rrule ? q('SELECT * FROM events WHERE recur_parent = ? ORDER BY recur_id').all(e.id).map((o) => ({ ...o, recurrenceId: o.recur_id })) : [];
  // An invitation shows who organises it and who's coming, so the phone offers Accept / Decline.
  const invite = e.my_status !== null && e.my_status !== undefined;
  const organizer = invite ? q('SELECT name, username AS email FROM users WHERE id = ?').get(e.owner_id) : null;
  const attendees = invite ? q('SELECT u.name, u.username AS email, g.status FROM event_guests g JOIN users u ON u.id = g.user_id WHERE g.event_id = ? ORDER BY u.username').all(e.id) : [];
  const alarms = e.for_user ? remindersOf(e.id, e.for_user) : []; // the reminders of the person syncing
  return buildIcs(outEvent(e), { method: null, uid: e.ical_uid || `${e.id}@${host()}`, sequence: e.sequence || 0, tz: e.tz, now: STAMP, overrides, organizer, attendees, alarms });
}
const PARTSTAT = { ACCEPTED: 'yes', TENTATIVE: 'maybe', DECLINED: 'no' };
const vcfOf = (c) => buildVcard(withPhoto(c));
const ctag = (bodies) => `"${crypto.createHash('sha1').update(bodies.join('\u0000')).digest('hex').slice(0, 24)}"`;
const repeatUntil = (e) => (e.rrule ? (e.rrule.until !== undefined ? e.rrule.until + (e.end - e.start) : null) : null);
const touch = (ids) => sendTo([].concat(ids), { type: 'events-changed' });

/**
 * Occurrences changed on their own in a phone's copy: each becomes (or updates) a one-off event
 * linked to the series, which skips that date; a cancelled one is just skipped; one no longer in
 * the copy is back to normal.
 */
export function syncOverrides(seriesId, e, userId) {
  const series = q('SELECT * FROM events WHERE id = ?').get(seriesId);
  const ex = new Set(JSON.parse(series.exdates || '[]'));
  const existing = new Map(q('SELECT * FROM events WHERE recur_parent = ?').all(seriesId).map((o) => [o.recur_id, o]));
  const keep = new Set();
  for (const o of e.rrule ? e.overrides || [] : []) {
    ex.add(o.recurrenceId);
    const cur = existing.get(o.recurrenceId);
    if (o.cancelled) { if (cur) q('DELETE FROM events WHERE id = ?').run(cur.id); continue; }
    keep.add(o.recurrenceId);
    const vals = [o.title, o.description, o.location, o.start, o.end, o.all_day, series.tz];
    if (cur) q('UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, tz = ?, sequence = sequence + 1 WHERE id = ?').run(...vals, cur.id);
    else q(`INSERT INTO events (title, description, location, start, end, all_day, tz, id, owner_id, color, exdates, recur_parent, recur_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
      .run(...vals, uid(), userId, series.color, seriesId, o.recurrenceId);
  }
  for (const [rid, cur] of existing) if (!keep.has(rid)) { q('DELETE FROM events WHERE id = ?').run(cur.id); if (!(e.overrides || []).some((o) => o.recurrenceId === rid)) ex.delete(rid); }
  q('UPDATE events SET exdates = ? WHERE id = ?').run(JSON.stringify([...ex].sort((a, b) => a - b)), seriesId);
}

export default function davRoutes() {
  const r = Router();
  r.use(express.text({ type: () => true, limit: MAX_BODY }));
  r.use((req, res, next) => {
    res.setHeader('DAV', '1, 3, calendar-access, addressbook');
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, REPORT');
    if (req.method === 'OPTIONS') return res.status(200).end();
    let user;
    try { user = authenticate(req); } catch (e) { return res.status(e.status || 500).end(); }
    if (!user) { res.setHeader('WWW-Authenticate', 'Basic realm="Workspace", charset="UTF-8"'); return res.status(401).send('Sign in with your email address and password (or your mail-app password)'); }
    req.davUser = user;
    next();
  });

  const base = (req) => req.baseUrl; // "/dav"
  const P = (req, ...parts) => `${base(req)}/${parts.map(encodeURIComponent).join('/')}${parts.length ? '/' : ''}`;
  const depth = (req) => (req.get('depth') === '0' ? 0 : 1);
  const send = (res, body) => res.status(207).type('application/xml; charset=utf-8').send(body);
  const privileges = '<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege><d:privilege><d:write-content/></d:privilege><d:privilege><d:bind/></d:privilege><d:privilege><d:unbind/></d:privilege>';

  function principalProps(req) {
    const u = req.davUser;
    return {
      'd:resourcetype': '<d:principal/>', 'd:displayname': esc(u.name),
      'd:current-user-principal': `<d:href>${P(req, 'principals', u.id)}</d:href>`, 'd:principal-URL': `<d:href>${P(req, 'principals', u.id)}</d:href>`,
      'cal:calendar-home-set': `<d:href>${P(req, 'calendars', u.id)}</d:href>`, 'card:addressbook-home-set': `<d:href>${P(req, 'addressbooks', u.id)}</d:href>`,
      'cal:calendar-user-address-set': `<d:href>mailto:${esc(u.username)}</d:href>`, 'd:current-user-privilege-set': privileges,
    };
  }
  const calendarProps = (req, events, cal = null) => ({
    'd:resourcetype': '<d:collection/><cal:calendar/>', 'd:displayname': esc(cal ? (cal.shared ? `${cal.name} (${cal.owner_name})` : cal.name) : 'Workspace'),
    'cal:supported-calendar-component-set': '<cal:comp name="VEVENT"/>', 'cs:getctag': esc(ctag(events.map(icsOf))),
    'd:current-user-privilege-set': readOnly(cal) ? '<d:privilege><d:read/></d:privilege>' : privileges, 'ic:calendar-color': `${cal ? cal.color.toUpperCase() : '#1a73e8'}FF`, 'd:owner': `<d:href>${P(req, 'principals', req.davUser.id)}</d:href>`,
    'cal:calendar-timezone': undefined,
  });
  const bookProps = (req, contacts) => ({
    'd:resourcetype': '<d:collection/><card:addressbook/>', 'd:displayname': 'Workspace contacts',
    'card:supported-address-data': '<card:address-data-type content-type="text/vcard" version="3.0"/>', 'cs:getctag': esc(ctag(contacts.map(vcfOf))),
    'd:current-user-privilege-set': privileges, 'd:owner': `<d:href>${P(req, 'principals', req.davUser.id)}</d:href>`,
  });
  const itemProps = (body, type, withData) => ({
    'd:getetag': esc(etagOf(body)), 'd:getcontenttype': type, 'd:resourcetype': '',
    ...(withData === 'cal' && { 'cal:calendar-data': esc(body) }), ...(withData === 'card' && { 'card:address-data': esc(body) }),
  });

  // Which of the user's things a path names; 403 for someone else's.
  function route(req) {
    const parts = req.path.split('/').filter(Boolean).map(decodeURIComponent);
    const me = req.davUser.id;
    if (parts.length === 0) return { kind: 'root' };
    const [area, owner, coll, item] = parts;
    if (owner && owner !== me) throw new HttpError(403, 'Not yours');
    if (area === 'principals' && parts.length === 2) return { kind: 'principal' };
    if ((area === 'calendars' || area === 'addressbooks') && parts.length === 2) return { kind: 'home', area };
    // A calendar: the main one ("default") or one of your own by its id.
    const cal = area === 'calendars' && coll && coll !== 'default'
      ? q('SELECT * FROM user_calendars WHERE id = ? AND owner_id = ?').get(coll, me) || q(`${SHARED} AND c.id = ?`).get(me, coll) : null;
    if (area === 'calendars' && coll && coll !== 'default' && !cal) return { kind: 'none' };
    if (area === 'calendars' && parts.length === 3) return { kind: 'calendar', cal };
    if (area === 'addressbooks' && coll === 'default' && parts.length === 3) return { kind: 'book' };
    if (area === 'calendars' && parts.length === 4) return { kind: 'event', name: item, cal };
    if (area === 'addressbooks' && coll === 'default' && parts.length === 4) return { kind: 'contact', name: item };
    return { kind: 'none' };
  }
  // An event by its file name in a calendar (invitations are in the main one).
  const findEvent = (userId, name, cal = null) => q('SELECT *, NULL AS my_status, ? AS for_user FROM events WHERE owner_id = ? AND calendar_id IS ? AND (dav_name = ? OR (dav_name IS NULL AND id || \'.ics\' = ?))').get(userId, userId, cal?.id ?? null, name, name)
    || (cal ? undefined : q(`SELECT e.*, g.status AS my_status, ? AS for_user FROM events e JOIN event_guests g ON g.event_id = e.id WHERE g.user_id = ? AND e.id || '.ics' = ?`).get(userId, userId, name));
  const findContact = (userId, name) => q('SELECT * FROM contacts WHERE owner_id = ? AND (dav_name = ? OR (dav_name IS NULL AND id || \'.vcf\' = ?))').get(userId, name, name);

  r.use((req, res, next) => {
    try {
      const at = route(req);
      const want = requested(req.body);
      const me = req.davUser.id;
      const m = req.method;

      if (m === 'PROPFIND') {
        const out = [];
        const add = (href, all) => { const [props, missing] = pick(all, want); out.push(response(href, props, missing)); };
        if (at.kind === 'root' || at.kind === 'principal') add(at.kind === 'root' ? `${base(req)}/` : P(req, 'principals', me), principalProps(req));
        else if (at.kind === 'home') {
          add(P(req, at.area, me), { 'd:resourcetype': '<d:collection/>', 'd:displayname': at.area === 'calendars' ? 'Calendars' : 'Address books', 'd:current-user-privilege-set': privileges });
          if (depth(req)) {
            if (at.area === 'calendars') {
              add(P(req, 'calendars', me, 'default'), calendarProps(req, eventsOf(me)));
              for (const c of ownCalendars(me)) add(P(req, 'calendars', me, c.id), calendarProps(req, eventsOf(me, c.id), c));
              for (const c of sharedCalendars(me)) add(P(req, 'calendars', me, c.id), calendarProps(req, viewOf(c, eventsOf(c.owner_id, c.id)), c));
            }
            else add(P(req, 'addressbooks', me, 'default'), bookProps(req, contactsOf(me)));
          }
        } else if (at.kind === 'calendar') {
          const events = viewOf(at.cal, eventsOf(at.cal?.owner_id ?? me, at.cal?.id));
          const coll = P(req, 'calendars', me, collOf(at.cal?.id));
          add(coll, calendarProps(req, events, at.cal));
          if (depth(req)) for (const e of events) add(`${coll}${encodeURIComponent(eventName(e))}`, itemProps(icsOf(e), 'text/calendar; charset=utf-8; component=vevent'));
        } else if (at.kind === 'book') {
          const contacts = contactsOf(me);
          add(P(req, 'addressbooks', me, 'default'), bookProps(req, contacts));
          if (depth(req)) for (const c of contacts) add(`${P(req, 'addressbooks', me, 'default')}${encodeURIComponent(contactName(c))}`, itemProps(vcfOf(c), 'text/vcard; charset=utf-8'));
        } else if (at.kind === 'event' || at.kind === 'contact') {
          const row = at.kind === 'event' ? findEvent(at.cal?.owner_id ?? me, at.name, at.cal) : findContact(me, at.name);
          if (!row) return res.status(404).end();
          add(req.baseUrl + req.path, at.kind === 'event' ? itemProps(icsOf(readOnly(at.cal) ? maskRow(row) : row), 'text/calendar; charset=utf-8') : itemProps(vcfOf(row), 'text/vcard; charset=utf-8'));
        } else return res.status(404).end();
        return send(res, multistatus(out));
      }

      if (m === 'REPORT') {
        if (at.kind !== 'calendar' && at.kind !== 'book') return res.status(404).end();
        const cal = at.kind === 'calendar';
        const coll = P(req, cal ? 'calendars' : 'addressbooks', me, cal ? collOf(at.cal?.id) : 'default');
        const rows = cal ? viewOf(at.cal, eventsOf(at.cal?.owner_id ?? me, at.cal?.id)) : contactsOf(me);
        const byHref = new Map(rows.map((x) => [`${coll}${encodeURIComponent(cal ? eventName(x) : contactName(x))}`, x]));
        const body = String(req.body || '');
        const withData = /calendar-data|address-data/.test(body) ? (cal ? 'cal' : 'card') : null;
        const one = (href, x) => { const [props, missing] = pick(itemProps(cal ? icsOf(x) : vcfOf(x), cal ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8', withData), want); return response(href, props, missing); };
        const out = [];
        if (/multiget/.test(body)) {
          for (const href of hrefsIn(body)) {
            const norm = href.replace(/^https?:\/\/[^/]+/, '');
            const x = byHref.get(norm) || byHref.get(encodeURI(norm));
            out.push(x ? one(norm, x) : notFoundResponse(norm));
          }
        } else {
          // calendar-query / addressbook-query: everything (phones filter by date themselves).
          for (const [href, x] of byHref) out.push(one(href, x));
        }
        return send(res, multistatus(out));
      }

      if (m === 'GET' || m === 'HEAD') {
        if (at.kind !== 'event' && at.kind !== 'contact') return res.status(at.kind === 'none' ? 404 : 200).type('text/plain').send(m === 'HEAD' ? '' : 'Workspace calendar and contacts sync. Add this address to your phone\'s Calendar or Contacts account settings.');
        const row = at.kind === 'event' ? findEvent(at.cal?.owner_id ?? me, at.name, at.cal) : findContact(me, at.name);
        if (!row) return res.status(404).end();
        const body = at.kind === 'event' ? icsOf(readOnly(at.cal) ? maskRow(row) : row) : vcfOf(row);
        res.setHeader('ETag', etagOf(body));
        return res.type(at.kind === 'event' ? 'text/calendar; charset=utf-8' : 'text/vcard; charset=utf-8').send(m === 'HEAD' ? '' : body);
      }

      if (m === 'PUT' || m === 'DELETE') {
        if (at.kind !== 'event' && at.kind !== 'contact') return res.status(405).end();
        if (!/^[\w.@+-]{1,200}$/.test(at.name)) return res.status(400).send('Unusable name');
        if (readOnly(at.cal)) return res.status(403).send(`${at.cal.owner_name} shares this calendar for you to see, not change`);
        const isEvent = at.kind === 'event';
        // In a colleague's calendar you may change: the event is theirs, and they're told.
        const actor = at.cal?.owner_id ?? me;
        const tell = (what, title) => { if (actor !== me) bell([actor], { kind: 'invite', title: `${req.davUser.name} ${what} ${title ? `“${title}”` : 'an event'} in ${at.cal.name}`, body: null, link: '/calendar', actor: req.davUser.name }); };
        const row = isEvent ? findEvent(at.cal?.owner_id ?? me, at.name, at.cal) : findContact(me, at.name);
        const current = row ? etagOf(isEvent ? icsOf(row) : vcfOf(row)) : null;
        // Conditional requests: don't overwrite a change made elsewhere in the meantime.
        const ifMatch = req.get('if-match'), ifNone = req.get('if-none-match');
        if (ifMatch && ifMatch !== '*' && ifMatch !== current) return res.status(412).end();
        if (ifMatch === '*' && !row) return res.status(412).end();
        if (ifNone === '*' && row) return res.status(412).end();

        const invite = isEvent && row && row.my_status !== null && row.my_status !== undefined;
        if (m === 'DELETE') {
          if (!row) return res.status(404).end();
          // Removing an invitation from the phone declines it; it stays the organiser's event.
          if (invite) { q("UPDATE event_guests SET status = 'no' WHERE event_id = ? AND user_id = ?").run(row.id, me); touch([me, row.owner_id]); return res.status(204).end(); }
          if (isEvent) q('DELETE FROM events WHERE id = ?').run(row.id);
          else trashContact(row.id, me); // a contact deleted on the phone can still be put back in Contacts → Trash
          if (isEvent) { q('DELETE FROM events WHERE recur_parent = ? AND owner_id = ?').run(row.id, actor); touch([me, actor, ...peopleOf(at.cal?.id)]); tell('deleted', row.title); }
          return res.status(204).end();
        }
        if (invite) {
          // A guest's copy: only their answer (Accept / Maybe / Decline) is kept.
          const mine = contentLines(req.body).find((l) => l.name === 'ATTENDEE' && l.value.toLowerCase() === `mailto:${req.davUser.username}`);
          const status = PARTSTAT[(mine?.params.PARTSTAT || '').toUpperCase()];
          if (status) { q('UPDATE event_guests SET status = ? WHERE event_id = ? AND user_id = ?').run(status, row.id, me); touch([me, row.owner_id]); }
          const theirs = parseIcsEvent(req.body, { tz: row.tz || 'UTC' }); // a guest's own reminders
          if (!theirs.error) { setReminders(row.id, me, theirs.reminders); touch([me]); }
          const saved = findEvent(at.cal?.owner_id ?? me, at.name, at.cal);
          if (saved) res.setHeader('ETag', etagOf(icsOf(saved)));
          return res.status(204).end();
        }

        if (isEvent) {
          const e = parseIcsEvent(req.body, { tz: row?.tz || 'UTC' });
          if (e.error) return res.status(415).send(e.error);
          // The same event put in another calendar on the phone: it moves there (with its guests and history).
          const elsewhere = !row && e.uid && actor === me ? q('SELECT * FROM events WHERE owner_id = ? AND ical_uid = ? AND recur_parent IS NULL AND calendar_id IS NOT ?').get(me, e.uid, at.cal?.id ?? null) : null;
          if (elsewhere) {
            q('UPDATE events SET calendar_id = ?, dav_name = ? WHERE id = ?').run(at.cal?.id ?? null, at.name, elsewhere.id);
            q('UPDATE events SET calendar_id = ? WHERE recur_parent = ? AND owner_id = ?').run(at.cal?.id ?? null, elsewhere.id, me);
            // It takes the new calendar's colour unless it had one of its own.
            const was = elsewhere.calendar_id ? q('SELECT color FROM user_calendars WHERE id = ?').get(elsewhere.calendar_id)?.color : null;
            if (!elsewhere.color || (was && elsewhere.color.toLowerCase() === was.toLowerCase())) q('UPDATE events SET color = ? WHERE id = ?').run(at.cal?.color ?? null, elsewhere.id);
          } else if (!row && e.uid && q('SELECT 1 FROM events WHERE owner_id = ? AND ical_uid = ?').get(actor, e.uid)) return res.status(409).send('An event with this UID already exists');
          const known = row || elsewhere;
          const id = known?.id || uid();
          const vals = [e.title, e.description, e.location, e.start, e.end, e.all_day, e.rrule ? JSON.stringify(e.rrule) : null, JSON.stringify(e.exdates || []), repeatUntil(e), zoneOrUtc(e.tz)];
          if (known) q('UPDATE events SET title = ?, description = ?, location = ?, start = ?, end = ?, all_day = ?, rrule = ?, exdates = ?, repeat_until = ?, tz = ?, sequence = sequence + 1 WHERE id = ?').run(...vals, id);
          else q(`INSERT INTO events (title, description, location, start, end, all_day, rrule, exdates, repeat_until, tz, id, owner_id, dav_name, ical_uid, color, calendar_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, id, actor, at.name, e.uid, at.cal?.color ?? null, at.cal?.id ?? null);
          q('UPDATE events SET show_as = ?, private = ? WHERE id = ?').run(e.show_as, e.private, id); // Free/Busy and Private, as set on the phone
          syncOverrides(id, e, actor);
          if (actor === me) setReminders(id, me, e.reminders); // a colleague's reminders on their events stay theirs
          touch([me, actor, ...peopleOf(at.cal?.id)]);
          tell(known ? 'changed' : 'added', e.title);
          const saved = q('SELECT *, NULL AS my_status, ? AS for_user FROM events WHERE id = ?').get(actor, id);
          res.setHeader('ETag', etagOf(icsOf(saved)));
          return res.status(row ? 204 : 201).end();
        }
        const c = parseVcard(req.body);
        if (c.error) return res.status(415).send(c.error);
        const id = row?.id || uid();
        const vals = [c.name, c.email, c.phone, c.company, c.title, c.address, c.website, c.notes, c.birthday, c.vcard_extra,
          c.more_emails?.length ? JSON.stringify(c.more_emails) : null, c.more_phones?.length ? JSON.stringify(c.more_phones) : null]; // other addresses and numbers too
        if (row) q('UPDATE contacts SET name = ?, email = ?, phone = ?, company = ?, title = ?, address = ?, website = ?, notes = ?, birthday = ?, vcard_extra = ?, more_emails = ?, more_phones = ? WHERE id = ?').run(...vals, id);
        else q('INSERT INTO contacts (name, email, phone, company, title, address, website, notes, birthday, vcard_extra, more_emails, more_phones, id, owner_id, created_at, dav_name, vcard_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...vals, id, me, now(), at.name, c.uid);
        q('UPDATE contacts SET dates = ?, custom_fields = ? WHERE id = ?').run(c.dates?.length ? JSON.stringify(c.dates) : null, c.custom_fields?.length ? JSON.stringify(c.custom_fields) : null, id); // other dates, fields of your own
        photoFromCard(id, c); // the phone's photo (or none, when the card has none)
        const saved = q('SELECT * FROM contacts WHERE id = ?').get(id);
        res.setHeader('ETag', etagOf(vcfOf(saved)));
        return res.status(row ? 204 : 201).end();
      }

      if (m === 'MKCALENDAR' || m === 'MKCOL' || m === 'PROPPATCH') {
        // A calendar of your own renamed or recoloured on the phone is kept; the main calendar's and
        // the address book's names and colours aren't. New calendars are made in Workspace.
        if (m === 'PROPPATCH') {
          if (at.kind === 'calendar' && at.cal && !at.cal.shared) {
            const body = String(req.body || '');
            const name = /<(?:\w+:)?displayname[^>]*>([^<]*)<\//.exec(body)?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 60);
            const color = /<(?:\w+:)?calendar-color[^>]*>\s*(#[0-9a-f]{6})(?:[0-9a-f]{2})?\s*<\//i.exec(body)?.[1]?.toLowerCase();
            if (name && !q('SELECT 1 FROM user_calendars WHERE owner_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(me, name, at.cal.id)) q('UPDATE user_calendars SET name = ? WHERE id = ?').run(name, at.cal.id);
            if (color && color !== at.cal.color) {
              q('UPDATE events SET color = ? WHERE calendar_id = ? AND owner_id = ? AND (color IS NULL OR LOWER(color) = LOWER(?))').run(color, at.cal.id, me, at.cal.color);
              q('UPDATE user_calendars SET color = ? WHERE id = ?').run(color, at.cal.id);
            }
            if (name || color) touch(me);
          }
          return send(res, multistatus([response(req.baseUrl + req.path, Object.fromEntries((want || []).map((k) => [k, ''])))]));
        }
        return res.status(403).send('Make new calendars in Workspace (Calendar → My calendars → +); they then show here');
      }
      return res.status(405).end();
    } catch (e) { next(e); }
  });

  // Errors here are plain status codes, not the JSON the web app gets.
  r.use((err, req, res, next) => { const status = err.status || 500; if (status >= 500) console.error('[dav]', err); res.status(status).type('text/plain').send(status >= 500 ? 'Server error' : err.message); });
  return r;
}
