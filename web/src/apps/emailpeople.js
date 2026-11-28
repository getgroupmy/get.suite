// "Email people with access" (in Docs, Sheets and Slides): a new email in Mail to everyone the file is shared with
// (by name: people, groups, its folders' shares), with its name as the subject and a link to it, ready to write and send.
// And "Schedule a meeting with people with access": a new event in Calendar with them as guests and the file attached.
import { get } from '../api.js';
import { DRAFT_KEY, EVENT_KEY } from './docs/blocks.js';
import { formatAddress } from '../components/addresses.js';

const APP = { doc: 'docs', sheet: 'sheets', slides: 'slides' };
const linkTo = (file, origin) => (APP[file.kind] ? `${origin}/${APP[file.kind]}/${file.id}` : `${origin}/drive?preview=${file.id}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The message for these people about this file: { to, subject, html }. */
export function messageAbout(file, people, origin) {
  const url = linkTo(file, origin);
  return { to: people.map((p) => formatAddress({ name: p.name, email: p.username })).join(', '), subject: file.name, html: `<p><a href="${esc(url)}">${esc(file.name)}</a></p><p></p>` };
}

export async function emailPeopleWithAccess(file, { navigate, toast }) {
  const people = await peopleFor(file, toast);
  if (!people) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(messageAbout(file, people, window.location.origin))); } catch { toast('Your browser’s storage is off, so the email can’t be started from here', 'error'); return; }
  navigate('/mail?compose_doc=1');
}

/** A new event about this file with these people as guests, at the next whole hour, an hour long. */
export function meetingAbout(file, people, origin, now = Date.now()) {
  const start = new Date(now); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
  const url = linkTo(file, origin);
  return {
    title: file.name, start: start.getTime(), end: start.getTime() + 3600e3, all_day: 0, location: '',
    guests: people.map((p) => ({ email: p.username })), description: `About “${file.name}”: ${url}`,
    attachments: [{ id: file.id, name: file.name, kind: file.kind, mime: null }],
  };
}

async function peopleFor(file, toast) {
  let r;
  try { r = await get(`/files/${file.id}/people`); } catch (e) { toast(e.message, 'error'); return null; }
  if (!r.people.length) {
    toast(r.everyone_at_company ? 'It’s shared with everyone at the company, and nobody by name' : 'Nobody else has access yet: share it first', 'info');
    return null;
  }
  return r.people;
}

export async function meetPeopleWithAccess(file, { navigate, toast }) {
  const people = await peopleFor(file, toast);
  if (!people) return;
  try { localStorage.setItem(EVENT_KEY, JSON.stringify(meetingAbout(file, people, window.location.origin))); } catch { toast('Your browser’s storage is off, so the event can’t be started from here', 'error'); return; }
  navigate('/calendar?new_doc=1');
}
