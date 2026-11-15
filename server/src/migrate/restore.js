// Bringing in an export from Google (Takeout), Microsoft 365 / Outlook.com or Zoho, through the same
// Settings → Bring in your data… as a Workspace .zip: see plan.js for what goes where.
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { planExport, contactsCsv } from './plan.js';
import { mboxEntry } from '../mail/mbox.js';
import { importCalendar } from '../calimport.js';
import { addCalendar } from '../mycalendars.js';
import { importContacts } from '../routes/contacts.js';
import { importNotes } from '../routes/notes.js';
import { importGoogleTasks } from '../routes/tasks.js';
import { intoDrive } from '../routes/takeout.js';
import { q } from '../db.js';
import { bad } from '../util.js';
import { sendTo } from '../hub.js';

const NAMES = { google: 'Google', microsoft: 'Microsoft', zoho: 'Zoho', other: 'your export' };
const CAL_COLORS = ['#039be5', '#7986cb', '#33b679', '#8e24aa', '#e67c73', '#f6bf26', '#f4511e', '#616161'];
const soft = (fn) => { try { return fn(); } catch (e) { if (e.status === 400 || e.status === 403) return { error: e.message }; throw e; } };

/** One calendar file's own name ("Work.ics" → "Work"; Google's "olivia@acme.com.ics" is the main one). */
const calName = (n) => n.slice(n.lastIndexOf('/') + 1).replace(/\.ics$/i, '').trim().slice(0, 60) || 'Imported';

export async function restoreForeign(entries, user, tz = 'UTC', onStep = () => {}) {
  const byName = new Map(entries.filter((e) => !e.dir).map((e) => [e.name, e]));
  const { source, plan, left_out: leftOut } = planExport(entries.map((e) => (e.dir && !e.name.endsWith('/') ? `${e.name}/` : e.name)));
  const of = (as) => plan.filter((x) => x.as === as);
  const text = async (name) => (await byName.get(name).buffer()).toString('utf8');
  const out = { source, from: NAMES[source] };
  // Contacts CSVs: only those that are contacts (a spreadsheet of something else goes to Drive).
  for (const x of of('contacts-csv?')) {
    const first = (await text(x.name)).replace(/^﻿/, '').split(/\r?\n/)[0];
    if (contactsCsv(first)) x.as = 'contacts-csv'; else { x.as = 'drive'; x.path ||= x.name.slice(x.name.lastIndexOf('/') + 1); }
  }
  if (!plan.some((x) => x.as !== 'skip')) throw bad(`There’s nothing in that .zip that can be brought in${leftOut.length ? ` (only ${leftOut.join(', ')})` : ''}`);

  // Calendars: the first one (or Google's, named after your address) into your calendar, others as calendars of their own.
  onStep({ step: 'calendar' });
  const cals = of('calendar');
  if (cals.length) {
    const main = cals.find((x) => calName(x.name).includes('@') && !/group\.|#/.test(calName(x.name))) || cals[0];
    const res = { added: 0, skipped: 0, calendars: [] };
    for (const [i, x] of cals.entries()) {
      let calId = null;
      if (x !== main) {
        const name = calName(x.name);
        calId = q('SELECT id FROM user_calendars WHERE owner_id = ? AND name = ? COLLATE NOCASE').get(user.id, name)?.id;
        if (!calId) { const made = soft(() => addCalendar(user.id, { name, color: CAL_COLORS[i % CAL_COLORS.length] })); calId = made?.id || null; }
        if (calId) res.calendars.push(name);
      }
      const r = importCalendar(user.id, await text(x.name), tz, calId);
      if (!r.error) { res.added += r.added; res.skipped += r.skipped; }
    }
    out.calendar = res;
  }
  // Contacts: vCards and contact CSVs (people already here are skipped, so Google's groups don't double anyone).
  onStep({ step: 'contacts' });
  const cards = [...of('contacts'), ...of('contacts-csv')];
  if (cards.length) {
    const res = { added: 0, skipped: 0 };
    for (const x of cards) {
      const body = await text(x.name);
      const r = soft(() => importContacts(user, body));
      if (r && !r.error) { res.added += r.added; res.skipped += r.skipped; }
    }
    out.contacts = res;
  }
  // Tasks: Google Tasks' Tasks.json, each list a new list.
  onStep({ step: 'tasks' });
  for (const x of of('tasks')) {
    let data; try { data = JSON.parse(await text(x.name)); } catch { continue; }
    const r = soft(() => importGoogleTasks(user, data));
    if (Array.isArray(r)) out.tasks = { lists: r.length, tasks: r.reduce((n, l) => n + l.tasks, 0) };
  }
  // Notes: Google Keep, as Keep's own import reads it (notes with their pictures).
  onStep({ step: 'notes' });
  const keep = of('keep');
  if (keep.some((x) => /\.json$/i.test(x.name))) {
    const z = new JSZip();
    for (const x of keep) z.file(x.name.replace(/^.*?Keep\//, 'Keep/'), await byName.get(x.name).buffer());
    try { out.notes = await importNotes(user, { files: [{ name: 'Keep.zip', base64: (await z.generateAsync({ type: 'nodebuffer' })).toString('base64') }] }); }
    catch (e) { if (e.status !== 400) throw e; }
  }
  // Drive files, and mail: .mbox files as they are, .eml files gathered into one .mbox per folder.
  const drive = of('drive').map((x) => ({ e: byName.get(x.name), path: x.path }));
  const mail = of('mbox').map((x) => ({ e: byName.get(x.name), path: x.name.slice(x.name.lastIndexOf('/') + 1), folder: x.folder ?? '', gmail: !!x.gmail }));
  const emlFolders = new Map();
  for (const x of of('eml')) { if (!emlFolders.has(x.folder)) emlFolders.set(x.folder, []); emlFolders.get(x.folder).push(x.name); }
  for (const [folder, names] of emlFolders) {
    const e = { stream: () => Readable.from((async function* () { for (const n of names) yield mboxEntry(await byName.get(n).buffer()); })()) };
    mail.push({ e, path: `${folder.replace(/[/\\]/g, '-') || 'Imported'}.mbox`, folder });
  }
  const label = { google: 'From Google', microsoft: 'From Microsoft', zoho: 'From Zoho', other: 'Brought in' }[source];
  Object.assign(out, await intoDrive(user, { drive, mail, rootName: `${label} ${new Date().toISOString().slice(0, 10)}`, onStep }));
  if (leftOut.length) out.left_out = leftOut;
  const skipped = plan.filter((x) => x.as === 'skip' && /\.pst/i.test(x.why || ''));
  if (skipped.length) out.pst = skipped.length;
  sendTo([user.id], { type: 'events-changed' });
  sendTo([user.id], { type: 'contacts-changed' });
  return out;
}
