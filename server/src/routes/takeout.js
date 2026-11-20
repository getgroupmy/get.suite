import { keptChatsOf } from '../meet.js';
// Download your data: everything you own in one .zip, in formats other programs open. Drive (with its
// folders; documents, spreadsheets and presentations as Word, Excel and PowerPoint, or OpenDocument), your calendar
// (.ics), contacts (.vcf), tasks (CSV), notes (Markdown) and email (an .mbox file per folder). Mounted at /api/takeout.
import { setVacation } from '../mail/vacation.js';
import { saveNow, CO_EDITED } from '../collab.js';
import { binExport } from '../recyclebin.js';
import { notesZipEntries, importNotes, noteTemplatesJson, importNoteTemplates } from './notes.js';
import { importContacts, groupsOf, importGroups } from './contacts.js';
import { allListsCsv, importTaskLists } from './tasks.js';
import { historyTable } from '../taskhistory.js';
import { myTimeCsv } from '../tasktime.js';
import { kudosCsv } from './kudos.js';
import { conversationFor } from './chat.js';
import { userSieve } from '../mail/sieve.js';
import { formsForExport, importForms } from './forms.js';
import { conversationText } from '../chatexport.js';
import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mailEnabled } from '../mail/config.js';
import { startMboxImport } from '../mail/importer.js';
import { writeMailbox, mailboxCounts } from '../mail/mbox.js';
import JSZip from 'jszip';
import unzipper from 'unzipper';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { roleFor, atLeast } from '../access.js';
import { q, tx, FILES_DIR } from '../db.js';
import { insertFile, cleanFileLabels, FILE_LABEL_COLORS, convertToWorkspace, officeExtras } from './files.js';
import { checkQuota } from '../tenancy.js';
import { indexSoon } from '../search.js';
import { bad, uid, mimeFor } from '../util.js';
import { audit } from '../audit.js';
import { sendTo } from '../hub.js';
import { forbidden, notFound } from '../util.js';
import { restoreForeign } from '../migrate/restore.js';
import { bookingPagesJson, importBookingPages } from './booking.js';
import { exportCalendar, importCalendar } from '../calimport.js';
import { importMailRules, importMailTemplates, importSignatures, importMailSearches } from './webmail.js';
import { feedsJson, importFeeds } from '../calfeeds.js';
import { addCalendar, MAX_CALENDARS } from '../mycalendars.js';
import { prefsJson, importPrefs } from '../prefsexport.js';
import { importEventTemplates } from './calendar.js';
import { contactsToVcf } from '../contactfiles.js';
import { withPhoto } from '../contactphotos.js';
import { wordFromDoc } from '../office/word.js';
import { odtFromDoc } from '../office/odt.js';
import { odsFromSheet } from '../office/ods.js';
import { odpFromDeck } from '../office/odp.js';
import { excelFromSheet } from '../office/excel.js';
import { powerPointFromDeck } from '../office/powerpoint.js';
import { withoutSuggestions } from '../office/suggestions.js';
import { docFromNotion, sheetFromNotionCsv } from '../migrate/notion.js';
import { csvCell } from '../csvcell.js';

const MAX_BYTES = 10 * 1024 ** 3; // stored files; beyond this, download Drive in parts
const safe = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 150) || 'untitled';


/** Where a comment is: the quoted text, a cell, a slide. */
function whereOf(anchor) {
  let a = null; try { a = anchor ? JSON.parse(anchor) : null; } catch { a = null; }
  if (!a) return '';
  if (a.quote) return `“${String(a.quote).slice(0, 80)}”`;
  if (a.cell) return `${a.sheet ? `Sheet ${Number(a.sheet) + 1} ` : ''}${a.cell}`;
  if (a.slide !== undefined && a.slide !== null) return `Slide ${typeof a.slide === 'number' ? a.slide + 1 : a.slide}`;
  return '';
}
/** Comments as CSV rows: the ones you wrote anywhere, and every one on files you own (file, where, by, when, what, reply or not, resolved). */
export function commentsCsv(userId) {
  const rows = q(`SELECT f.name AS file, c.anchor, root.anchor AS root_anchor, u.name AS author, c.created_at, c.edited_at, c.body, c.thread_id, root.resolved
                  FROM file_comments c JOIN files f ON f.id = c.file_id JOIN file_comments root ON root.id = COALESCE(c.thread_id, c.id)
                  LEFT JOIN users u ON u.id = c.author_id
                  WHERE c.author_id = ? OR f.owner_id = ?
                  ORDER BY f.name COLLATE NOCASE, root.created_at, c.created_at`).all(userId, userId);
  const head = ['File', 'Where', 'By', 'Written', 'Comment', 'Reply', 'Resolved'];
  return [head, ...rows.map((r) => [r.file, whereOf(r.thread_id ? r.root_anchor : r.anchor), r.author || '', new Date(r.edited_at || r.created_at).toISOString().replace('T', ' ').slice(0, 16), r.body, r.thread_id ? 'yes' : '', r.resolved ? 'yes' : ''])]
    .map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * The conversations someone is in that have messages, for the export: direct messages and private channels they're
 * a member of, and public channels they joined or wrote in and haven't left (public channels keep no list of members).
 */
export function conversationsOf(userId) {
  return q(`SELECT id FROM channels c WHERE (EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?)
              OR (c.dm_key IS NULL AND c.private = 0 AND EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id AND m.user_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM chat_left l WHERE l.channel_id = c.id AND l.user_id = ?)))
            AND EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) ORDER BY c.created_at`).all(userId, userId, userId);
}

/** Mail settings worth keeping when moving elsewhere: [[path, content]] — filters (Sieve, which most mail servers
 *  take, and the rules as JSON), signatures and templates (HTML) and the vacation reply (text). Nothing for what isn't set. */
export function mailSettingsFiles(userId, username) {
  const out = [];
  const rules = (() => { try { return JSON.parse(q('SELECT rules FROM mail_rules WHERE user_id = ?').get(userId)?.rules || '[]'); } catch { return []; } })();
  if (rules.length) {
    const labels = (() => { try { return new Map(q('SELECT id, keyword FROM mail_labels WHERE user_id = ?').all(userId).map((l) => [l.id, l.keyword])); } catch { return new Map(); } })();
    out.push(['Mail settings/filters.sieve', userSieve({ username, rules, labels }) || '']);
    out.push(['Mail settings/filters.json', `${JSON.stringify(rules, null, 2)}\n`]);
  }
  // Labels (with their colours), so filters that label mail can be set up again elsewhere.
  const labels = (() => { try { return q('SELECT id, name, color FROM mail_labels WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId); } catch { return []; } })();
  if (labels.length) out.push(['Mail settings/labels.json', `${JSON.stringify(labels, null, 2)}\n`]);
  // Saved searches (Mail's list of them), to be saved again elsewhere.
  const searches = (() => { try { return q('SELECT name, folder, query FROM mail_searches WHERE user_id = ? ORDER BY position, created_at').all(userId); } catch { return []; } })();
  if (searches.length) out.push(['Mail settings/saved searches.json', `${JSON.stringify(searches.map((x) => ({ ...x })), null, 2)}\n`]);
  const sig = q("SELECT html FROM mail_signatures WHERE user_id = ? AND html != ''").get(userId);
  if (sig) out.push(['Mail settings/signature.html', sig.html]);
  for (const s of q("SELECT address, html FROM identity_signatures WHERE user_id = ? AND html != '' ORDER BY address").all(userId)) out.push([`Mail settings/signature ${safe(s.address)}.html`, s.html]);
  const v = q("SELECT subject, body, start_date, end_date, enabled FROM vacations WHERE user_id = ? AND (subject != '' OR body != '')").get(userId);
  // Templates (canned replies): one HTML page each, its subject as the page's title.
  const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const names = new Set();
  for (const t of (() => { try { return q('SELECT name, subject, html FROM mail_templates WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId); } catch { return []; } })()) {
    let base = safe(t.name), n = 1;
    while (names.has(base.toLowerCase())) base = `${safe(t.name)} (${++n})`;
    names.add(base.toLowerCase());
    out.push([`Mail settings/templates/${base}.html`, `<!doctype html><meta charset="utf-8"><title>${esc(t.subject || t.name)}</title>\n${t.html}\n`]);
  }
  if (v) out.push(['Mail settings/vacation reply.txt', [`Subject: ${v.subject}`, `On: ${v.enabled ? 'yes' : 'no'}${v.start_date ? `, from ${v.start_date}` : ''}${v.end_date ? ` until ${v.end_date}` : ''}`, '', v.body].join('\r\n')]);
  return out;
}

/** Your event templates (Calendar → Template), as JSON, or null when there are none. */
export function eventTemplatesJson(userId) {
  let rows = [];
  try { rows = q('SELECT name, data FROM event_templates WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId); } catch { rows = []; }
  return rows.length ? `${JSON.stringify(rows.map((r) => ({ name: r.name, ...JSON.parse(r.data) })), null, 2)}\n` : null;
}

/** Your notes as one Markdown file. */
export function notesMarkdown(userId) {
  const notes = q('SELECT * FROM notes WHERE owner_id = ? AND trashed_at IS NULL ORDER BY archived, pinned DESC, position DESC').all(userId);
  return notes.map((n) => {
    const labels = JSON.parse(n.labels || '[]');
    const items = n.items ? JSON.parse(n.items) : null;
    return [`## ${n.title || 'Note'}${n.archived ? ' (archived)' : ''}${n.pinned ? ' 📌' : ''}`,
      ...(labels.length ? [`Labels: ${labels.join(', ')}`, ''] : []),
      items ? items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n') : n.body,
      ''].join('\n');
  }).join('\n') || '_No notes._\n';
}

/**
 * A Download your data .zip brought back in, from its entries ([{ name, dir, buffer(), stream() }]): Drive (one new folder),
 * email (its .mbox files imported), calendar, contacts, task lists, notes and settings. What it added, by kind.
 */
/**
 * Files into one new Drive folder (rootName), keeping their folders: drive [{ e, path, dir? }] and mail [{ e, path, folder, gmail? }]
 * (.mbox files, kept in a "Mail (.mbox)" folder inside it and imported into the mailbox in the background).
 * { drive: { folder, folder_id, files }, mail: { folders, started, error? } } (each only when there was some).
 */
export async function intoDrive(user, { drive: driveEntries, mail: mailEntries, rootName, onStep = () => {}, ids = null }) {
  const out = {};
  if (!driveEntries.some((x) => !x.dir) && !mailEntries.length) return out;
  if (driveEntries.length > 20000) throw bad('That Drive has more than 20,000 files and folders: upload its folders in Drive instead');
  const MAILDIR = '\u0000mail'; // its own folder, even if the Drive has one called Mail
  // Pages and databases from Notion (convert: 'doc' or 'sheet') become documents and spreadsheets: read whole, made below.
  const converts = [];
  for (const x of driveEntries.filter((y) => !y.dir && y.convert)) {
    const chunks = []; let n = 0;
    for await (const c of x.e.stream()) { n += c.length; if (n > 10 * 1024 * 1024) throw bad(`“${x.path}” is too big to bring in as a ${x.convert === 'doc' ? 'document' : 'spreadsheet'} (10 MB at most)`); chunks.push(c); }
    converts.push({ ...x, text: Buffer.concat(chunks).toString('utf8') });
  }
  const toWrite = [...driveEntries.filter((x) => !x.dir && !x.convert).map((x) => ({ e: x.e, path: x.path, from: x.from })),
    ...mailEntries.map((x) => ({ e: x.e, path: `${MAILDIR}/${x.path}`, mailFolder: x.folder ?? '', gmail: !!x.gmail }))];
  // Each file straight to disk, one at a time (a big Drive never sits in memory); then all of them recorded at once.
  const written = [];
  const drop = () => { for (const w of written) fs.rmSync(path.join(FILES_DIR, w.storage), { force: true }); };
  try {
    for (const [k, w] of toWrite.entries()) {
      if (k % 20 === 0) onStep({ step: 'drive', done: k, total: toWrite.length });
      const one = { ...w, storage: uid() };
      written.push(one);
      await pipeline(w.e.stream(), fs.createWriteStream(path.join(FILES_DIR, one.storage)));
      one.size = fs.statSync(path.join(FILES_DIR, one.storage)).size;
    }
    checkQuota(user.org_id, written.reduce((n, w) => n + w.size, 0) + converts.reduce((n, c) => n + Buffer.byteLength(c.text), 0), user.id);
  } catch (e) { drop(); throw e; }
  const mboxes = [];
  try {
    tx(() => {
      const root = insertFile({ owner: user.id, parentId: null, name: rootName, kind: 'folder' });
      const byFrom = new Map(); // a file's name in the .zip → its Drive id (pictures in Notion pages)
      const folders = new Map([['', root]]);
      const folderFor = (dir) => {
        if (folders.has(dir)) return folders.get(dir);
        const cut = dir.lastIndexOf('/');
        const id = insertFile({ owner: user.id, parentId: folderFor(cut < 0 ? '' : dir.slice(0, cut)), name: (dir === MAILDIR ? 'Mail (.mbox)' : dir.slice(cut + 1)).slice(0, 255) || 'Folder', kind: 'folder' });
        folders.set(dir, id);
        return id;
      };
      for (const x of driveEntries.filter((y) => y.dir)) if (x.path) folderFor(x.path); // empty folders too
      for (const w of written) {
        const cut = w.path.lastIndexOf('/');
        const fid = insertFile({ owner: user.id, parentId: folderFor(cut < 0 ? '' : w.path.slice(0, cut)), name: w.path.slice(cut + 1).slice(0, 255), kind: 'file', mime: w.mailFolder !== undefined ? 'application/mbox' : mimeFor(w.path), size: w.size, storage: w.storage });
        if (w.mailFolder !== undefined) mboxes.push({ id: fid, folder: w.mailFolder, ...(w.gmail && { gmail: true }) });
        if (w.from) byFrom.set(w.from, fid);
        if (ids && w.mailFolder === undefined) ids.set(w.path, fid);
      }
      if (ids) for (const [dir, id] of folders) if (dir && dir !== MAILDIR) ids.set(dir, id);
      // Documents first made empty (so pages can link to each other), then filled; spreadsheets straight away.
      const docIds = new Map();
      for (const c of converts) {
        const cut = c.path.lastIndexOf('/');
        const parentId = folderFor(cut < 0 ? '' : c.path.slice(0, cut));
        const name = c.path.slice(cut + 1).slice(0, 255) || 'Untitled';
        if (c.convert === 'sheet') {
          const content = JSON.stringify(sheetFromNotionCsv(c.text, name));
          insertFile({ owner: user.id, parentId, name, kind: 'sheet', content, size: Buffer.byteLength(content) });
        } else docIds.set(c.from, insertFile({ owner: user.id, parentId, name, kind: 'doc', content: '{"type":"doc","content":[]}', size: 0 }));
      }
      for (const c of converts.filter((x) => x.convert === 'doc')) {
        const fromDir = c.from.includes('/') ? c.from.slice(0, c.from.lastIndexOf('/')) : '';
        const doc = docFromNotion(c.text, { fromDir, pictureFor: (p) => byFrom.get(p) || null, pageFor: (p) => (docIds.get(p) ? `/docs/${docIds.get(p)}` : null) });
        const content = JSON.stringify(doc);
        q('UPDATE files SET content = ?, size = ? WHERE id = ?').run(content, Buffer.byteLength(content), docIds.get(c.from));
      }
      out.drive = { folder: rootName, folder_id: root, files: written.length - mboxes.length + converts.length };
    });
  } catch (e) { drop(); throw e; }
  sendTo([user.id], { type: 'files-changed' });
  indexSoon();
  if (mboxes.length) {
    if (!mailEnabled()) out.mail = { folders: mboxes.length, started: false, error: 'Mail isn’t set up on this server: the .mbox files are in the Drive folder' };
    else {
      try { await startMboxImport(user, { files: mboxes }); out.mail = { folders: mboxes.length, started: true }; }
      catch (e) { out.mail = { folders: mboxes.length, started: false, error: `${e.message}: the .mbox files are in the Drive folder, for Mail → Import mail later` }; }
    }
  }
  return out;
}

/** Drive details.json onto the files brought in (by their path in the .zip): { files } (how many got something back). */
export function applyDriveDetails(userId, details, ids) {
  let files = 0;
  for (const [label, color] of Object.entries(details.label_colors && typeof details.label_colors === 'object' ? details.label_colors : {}).slice(0, 200)) {
    if (FILE_LABEL_COLORS.includes(color) && String(label).trim()) q('INSERT INTO file_label_colors (user_id, label, color) VALUES (?, ?, ?) ON CONFLICT(user_id, label) DO NOTHING').run(userId, String(label).slice(0, 30), color);
  }
  for (const d of details.files.slice(0, 20000)) {
    const id = ids.get(String(d?.path || '').replace(/\/$/, ''));
    if (!id) continue;
    let did = false;
    if (d.starred) { q('INSERT OR IGNORE INTO file_stars (user_id, file_id, created_at) VALUES (?, ?, ?)').run(userId, id, Date.now()); did = true; }
    if (/^#[0-9a-f]{6}$/i.test(d.color || '')) { q("UPDATE files SET color = ? WHERE id = ? AND kind = 'folder'").run(d.color, id); did = true; }
    if (typeof d.description === 'string' && d.description.trim()) { q('UPDATE files SET description = ? WHERE id = ?').run(d.description.slice(0, 2000), id); did = true; }
    if (Array.isArray(d.labels)) {
      let labels = [];
      try { labels = cleanFileLabels(d.labels); } catch { labels = []; }
      for (const l of labels) q('INSERT OR IGNORE INTO file_labels (user_id, file_id, label) VALUES (?, ?, ?)').run(userId, id, l);
      if (labels.length) did = true;
    }
    if (did) files++;
  }
  return { files };
}

export async function restoreFrom(entries, user, tz = 'UTC', onStep = () => {}) {
  const byName = new Map(entries.filter((e) => !e.dir).map((e) => [e.name, e]));
  const text = async (name) => { const e = byName.get(name); return e ? (await e.buffer()).toString('utf8') : undefined; };
  // Not Workspace's own: an export from Google (Takeout), Microsoft or Zoho, or any .zip of files.
  if (!/Your Workspace data/.test(await text('README.txt') || '')) return restoreForeign(entries, user, tz, onStep);
  const files = entries.filter((e) => !e.dir);
  const out = {};
  onStep({ step: 'calendar' });
  // Your other calendars first (one with the same name here is used), so their events go back into them.
  const calByName = new Map(q('SELECT id, name FROM user_calendars WHERE owner_id = ?').all(user.id).map((c) => [c.name.toLowerCase(), c.id]));
  const cals = await (async () => { try { return JSON.parse(await text('Calendars.json') || 'null'); } catch { return null; } })();
  if (Array.isArray(cals)) {
    let made = 0;
    for (const c of cals.slice(0, MAX_CALENDARS)) {
      const name = String(c?.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!name || calByName.has(name.toLowerCase())) continue;
      try { const nc = addCalendar(user.id, { name, color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : undefined }); if (c.hidden) q('UPDATE user_calendars SET hidden = 1 WHERE id = ?').run(nc.id); calByName.set(name.toLowerCase(), nc.id); made++; }
      catch (e) { if (e.status !== 400) throw e; } // at most MAX_CALENDARS
    }
    if (made) out.calendars = { added: made };
  }
  const ics = await text('Calendar.ics');
  if (ics) { const r2 = importCalendar(user.id, ics, tz, null, null, { calendarByName: (n) => calByName.get(n.toLowerCase()) }); out.calendar = r2.error ? { added: 0, skipped: 0 } : { added: r2.added, skipped: r2.skipped }; }
  onStep({ step: 'contacts' });
  const vcf = await text('Contacts.vcf');
  if (vcf && /BEGIN:VCARD/i.test(vcf)) out.contacts = importContacts(user, vcf);
  // Contact groups (a name already used here is left as it is).
  const groupsText = await text('Contact groups.json');
  if (groupsText) { try { out.contact_groups = importGroups(user.id, JSON.parse(groupsText)); } catch { /* not readable: left out */ } }
  onStep({ step: 'tasks' });
  const csv = await text('Tasks.csv');
  if (csv) {
    try { const r2 = importTaskLists(user, csv); out.tasks = { lists: r2.lists.length, tasks: r2.lists.reduce((n, l) => n + l.tasks, 0) }; }
    catch (e) { if (e.status !== 400) throw e; out.tasks = { lists: 0, tasks: 0 }; } // no tasks in it
  }
  // Settings that travel with you: mail filters, email templates, signatures and event templates (each skipped if already here).
  const tryImport = (fn) => { try { return fn(); } catch (e) { if (e.status === 400 || e.status === 403) return { added: 0, skipped: 0, error: e.message }; throw e; } };
  const json = async (name) => { const t = await text(name); if (!t) return null; try { return JSON.parse(t); } catch { return null; } };
  onStep({ step: 'settings' });
  // Labels first (by name: one already here is used), so filters that label mail still do.
  const labelMap = new Map();
  const labelList = await json('Mail settings/labels.json');
  if (Array.isArray(labelList)) {
    let made = 0;
    for (const l of labelList.slice(0, 100)) {
      const name = String(l?.name || '').trim().slice(0, 50);
      if (!name) continue;
      const had = q('SELECT id FROM mail_labels WHERE user_id = ? AND lower(name) = lower(?)').get(user.id, name);
      let id = had?.id;
      if (!id && q('SELECT COUNT(*) AS n FROM mail_labels WHERE user_id = ?').get(user.id).n < 100) {
        id = uid();
        q('INSERT INTO mail_labels (id, user_id, name, color, keyword, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, user.id, name, /^#[0-9a-f]{6}$/i.test(l.color || '') ? l.color : '#5f6368', `nwl_${id.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`, Date.now());
        made++;
      }
      if (id && l.id) labelMap.set(String(l.id), id);
    }
    if (made) out.labels = { added: made };
  }
  const rules = (await json('Mail settings/filters.json'))?.map?.((x) => (x?.actions?.label && labelMap.has(String(x.actions.label)) ? { ...x, actions: { ...x.actions, label: labelMap.get(String(x.actions.label)) } } : x));
  if (Array.isArray(rules) && rules.length) { const r2 = tryImport(() => importMailRules(user, { rules })); out.filters = { added: r2.added, skipped: r2.skipped, ...(r2.error && { error: r2.error }) }; }
  const unesc = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const templates = [];
  for (const f of files.filter((x) => /^Mail settings\/templates\/[^/]+\.html$/.test(x.name))) {
    const page = (await f.buffer()).toString('utf8');
    const m = /^<!doctype html><meta charset="utf-8"><title>([^<]*)<\/title>\n([\s\S]*?)\n?$/i.exec(page);
    const name = f.name.split('/').pop().replace(/\.html$/, '');
    const title = m ? unesc(m[1]) : '';
    templates.push({ name, subject: title === name ? '' : title, html: m ? m[2] : page }); // the title is the subject, or the name when it had none
  }
  if (templates.length) out.templates = tryImport(() => importMailTemplates(user, { templates }));
  const sigs = [];
  for (const f of files.filter((x) => /^Mail settings\/signature( [^/]+)?\.html$/.test(x.name))) {
    const m = /^Mail settings\/signature(?: ([^/]+))?\.html$/.exec(f.name);
    sigs.push({ address: m[1] ? m[1].toLowerCase() : null, html: (await f.buffer()).toString('utf8') });
  }
  if (sigs.length) out.signatures = importSignatures(user, sigs);
  // The vacation reply (when none is set here): its words and days, on only if it hasn't ended.
  const vac = await text('Mail settings/vacation reply.txt');
  if (vac && !q("SELECT 1 FROM vacations WHERE user_id = ? AND body != ''").get(user.id)) {
    const [head, ...rest] = vac.replace(/\r\n/g, '\n').split('\n\n');
    const subject = /^Subject: (.*)$/m.exec(head)?.[1]?.trim().slice(0, 200) || 'Out of office';
    const on = /^On: (yes|no)(?:, from (\d{4}-\d{2}-\d{2}))?(?: until (\d{4}-\d{2}-\d{2}))?/m.exec(head);
    const body = rest.join('\n\n').trim().slice(0, 5000);
    const today = new Date().toISOString().slice(0, 10);
    if (body) {
      setVacation(user.id, { enabled: on?.[1] === 'yes' && !(on?.[3] && on[3] < today), subject, body, start_date: on?.[2] || null, end_date: on?.[3] || null });
      out.vacation = true;
    }
  }
  const evTemplates = await json('Calendar templates.json');
  if (Array.isArray(evTemplates) && evTemplates.length) out.event_templates = tryImport(() => importEventTemplates(user, { templates: evTemplates }));
  // Your own settings (working hours, world clocks, how Mail looks…), each only where it's still the default here.
  const prefs = await json('Settings.json');
  if (prefs) { const r2 = importPrefs(user.id, prefs); if (r2.added) out.settings = r2; }
  // Calendars subscribed to by address (fetched again from there) and saved mail searches.
  const feeds = await json('Calendar subscriptions.json');
  if (Array.isArray(feeds) && feeds.length) out.calendar_subscriptions = importFeeds(user.id, feeds);
  const searches = await json('Mail settings/saved searches.json');
  if (Array.isArray(searches) && searches.length) out.saved_searches = importMailSearches(user.id, searches);
  // Booking pages: each comes back with a new link (the old one was this account's on the other server).
  const bookingPages = await json('Booking pages.json');
  if (Array.isArray(bookingPages) && bookingPages.length) out.booking_pages = importBookingPages(user, bookingPages);
  const noteTemplates = await json('Note templates.json');
  if (Array.isArray(noteTemplates) && noteTemplates.length) out.note_templates = tryImport(() => importNoteTemplates(user, noteTemplates));
  // Drive: the Drive/ folder comes in as one new folder ("From your data 2026-11-13") with its folders and files as they were
  // (documents as the Word, Excel or PowerPoint files they were saved as). Nothing already in your Drive is touched.
  // Email: Mail/<folder>.mbox files are kept in that Drive folder too ("Mail (.mbox)") and imported into your mailbox.
  const driveEntries = entries.filter((x) => x.name.startsWith('Drive/') && x.name !== 'Drive/' && !/(^|\/)(__MACOSX|\.DS_Store)/.test(x.name))
    .map((e) => ({ e, dir: e.dir, path: e.name.slice('Drive/'.length).replace(/\/$/, '') }));
  const mailEntries = files.filter((x) => /^Mail\/.+\.mbox$/i.test(x.name)).map((e) => ({ e, path: e.name.slice('Mail/'.length), folder: e.name.slice('Mail/'.length).replace(/\.mbox$/i, '') }));
  const driveIds = new Map();
  Object.assign(out, await intoDrive(user, { drive: driveEntries, mail: mailEntries, rootName: `From your data ${new Date().toISOString().slice(0, 10)}`, onStep, ids: driveIds }));
  // Stars, folder colours, descriptions and labels, on the files and folders just brought in.
  const details = await json('Drive details.json');
  if (details && Array.isArray(details.files) && driveIds.size) {
    // Documents, spreadsheets and presentations (downloaded as Word, Excel and PowerPoint, or OpenDocument) become them
    // again, under their own names; the downloaded file goes to the trash (as when uploads are converted). One that
    // can't be read stays as the file it came as.
    let converted = 0, kept = 0;
    const marked = details.files.filter((d) => ['doc', 'sheet', 'slides'].includes(d?.kind) && driveIds.has(String(d.path)));
    for (const [k, d] of marked.entries()) {
      if (k % 10 === 0) onStep({ step: 'documents', done: k, total: marked.length });
      const f = q("SELECT * FROM files WHERE id = ? AND kind = 'file'").get(driveIds.get(String(d.path)));
      if (!f) continue;
      try {
        const id = await convertToWorkspace(f, user);
        q('UPDATE files SET trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), f.id);
        driveIds.set(String(d.path), id);
        converted++;
      } catch (e) { if (e.status !== 400 && e.status !== 413) throw e; kept++; }
    }
    if (converted || kept) out.documents = { converted, kept };
    out.drive_details = applyDriveDetails(user.id, details, driveIds);
  }
  // Files sent with forms (in their "(File uploads)" folders, brought in with Drive): their old id → the new one.
  const formFiles2 = new Map();
  if (details && Array.isArray(details.files)) for (const d of details.files) if (d?.id && driveIds.has(String(d.path))) formFiles2.set(String(d.id), driveIds.get(String(d.path)));
  // Forms: each made again (a new link) with its responses.
  const formFiles = files.filter((x) => /^Forms\/.+ - form\.json$/.test(x.name));
  if (formFiles.length) {
    const list = [];
    for (const f of formFiles) { try { list.push(JSON.parse((await f.buffer()).toString('utf8'))); } catch { /* not readable: left out */ } }
    out.forms = importForms(user, list, { fileFor: (oldId) => formFiles2.get(oldId) || null });
  }
  // Notes: its Notes/ folder (with pictures), through Import notes… (which reads only Notes/ from a Download your data .zip).
  onStep({ step: 'notes' });
  const noteEntries = files.filter((x) => x.name.startsWith('Notes/'));
  if (noteEntries.some((x) => x.name.endsWith('.md'))) {
    const nz = new JSZip();
    nz.file('README.txt', 'Your Workspace data');
    for (const e of noteEntries) nz.file(e.name, await e.buffer());
    out.notes = await importNotes(user, { files: [{ name: 'data.zip', base64: (await nz.generateAsync({ type: 'nodebuffer' })).toString('base64') }] });
  }
  sendTo([user.id], { type: 'events-changed' });
  return out;
}

/** Background restores, by the account they go into (the latest one each; kept until the server restarts). */
const restores = new Map();

export default function takeoutRoutes() {
  const r = Router();
  // What's in it, before downloading.
  const whose = (req) => {
    if (!req.query.user || req.query.user === req.user.id) return { id: req.user.id, username: req.user.username };
    if (!req.user.is_admin) throw forbidden('Admins only');
    const u = q('SELECT id, org_id, username FROM users WHERE id = ?').get(String(req.query.user));
    if (!u || (u.org_id !== req.user.org_id && !req.user.is_super)) throw notFound('No such person');
    return u;
  };

  // Bring a Download your data .zip back in (moving to another server, or after a mistake): its calendar, contacts, task lists
  // and notes are added to yours, skipping what's already here (events by their UID, contacts by address; lists come in as new ones).
  // Drive files and email have their own ways in (upload a folder; Mail → Import mail from its .mbox files).
  // How the last background restore into this account (or ?user=, for an admin) went: { status, step, done, total, result | error }.
  r.get('/restore/status', (req, res) => {
    const who = whose(req);
    res.json(restores.get(who.id) || { status: 'none' });
  });
  r.post('/restore', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
    // ?user=<id>: an admin bringing it into a colleague's account (Admin → Users → Bring in their data…).
    const who = whose(req);
    const user = who.id === req.user.id ? req.user : q('SELECT * FROM users WHERE id = ?').get(who.id);
    let entries;
    if (req.query.file_id) {
      // A .zip already in Drive (uploaded there, for one too big to send here): read from disk, an entry at a time.
      const f = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(String(req.query.file_id));
      if (!f || !atLeast(roleFor(f.id, req.user.id) || '', 'viewer')) throw notFound('File not found');
      let dir;
      try { dir = await unzipper.Open.file(path.join(FILES_DIR, f.storage)); } catch { throw bad('That isn’t a .zip file'); }
      entries = dir.files.map((e) => ({ name: e.path, dir: e.type === 'Directory', size: e.uncompressedSize, buffer: () => e.buffer(), stream: () => e.stream() }));
    } else {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let zip;
      try { zip = await JSZip.loadAsync(buf); } catch { throw bad('That isn’t a .zip file'); }
      entries = Object.values(zip.files).map((e) => ({ name: e.name, dir: e.dir, buffer: () => e.async('nodebuffer'), stream: () => Readable.from((async function* () { yield await e.async('nodebuffer'); })()) })); // already in memory
    }
    const tz = String(req.query.tz || 'UTC');
    const target = user.id === req.user.id ? null : user.username;
    if (req.query.background === '1') {
      // In the background (a big one can take longer than a page waits): GET /restore/status says how it's going.
      if (restores.get(user.id)?.status === 'running') throw bad('Your data is already being brought in');
      const job = { status: 'running', step: 'starting', started_at: Date.now(), by: req.user.id };
      restores.set(user.id, job);
      const set = (x) => { Object.assign(job, x); sendTo([...new Set([user.id, req.user.id])], { type: 'restore-progress', user_id: user.id, restore: job }); };
      restoreFrom(entries, user, tz, (p) => set({ step: p.step, done: p.done ?? null, total: p.total ?? null }))
        .then((out) => { audit(req, 'takeout.restore', { target, details: out }); set({ status: 'done', result: out, finished_at: Date.now() }); })
        .catch((e) => set({ status: 'failed', error: String(e.message || e).slice(0, 300), finished_at: Date.now() }));
      return res.status(202).json(job);
    }
    const out = await restoreFrom(entries, user, tz);
    audit(req, 'takeout.restore', { target, details: out });
    res.json(out);
  });

  r.get('/summary', async (req, res) => {
    const who = whose(req);
    const me = who.id;
    const n = (sql) => q(sql).get(me).n;
    res.json({
      files: n("SELECT COUNT(*) AS n FROM files WHERE owner_id = ? AND trashed = 0 AND kind != 'folder'"),
      bytes: n("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ? AND trashed = 0 AND kind = 'file'"),
      events: n('SELECT COUNT(*) AS n FROM events WHERE owner_id = ? AND recur_parent IS NULL'),
      contacts: n('SELECT COUNT(*) AS n FROM contacts WHERE owner_id = ?'),
      tasks: n('SELECT COUNT(*) AS n FROM tasks t JOIN task_lists l ON l.id = t.list_id WHERE l.owner_id = ?'),
      notes: n('SELECT COUNT(*) AS n FROM notes WHERE owner_id = ?'),
      comments: q('SELECT COUNT(*) AS n FROM file_comments c JOIN files f ON f.id = c.file_id WHERE c.author_id = ? OR f.owner_id = ?').get(me, me).n,
      conversations: conversationsOf(me).length,
      forms: n('SELECT COUNT(*) AS n FROM forms WHERE owner_id = ?'),
      // Email (null when this server has none, or the mail server can't be reached just now).
      mail: mailEnabled() ? (await mailboxCounts(who).catch(() => null))?.messages ?? null : null,
    });
  });

  /** Whose data: your own, or (admins) someone's in your company, for when they leave: ?user=<id>. */

  r.get('/', async (req, res) => {
    const who = whose(req);
    const me = who.id;
    const bytes = q("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ? AND trashed = 0 AND kind = 'file'").get(me).n;
    if (bytes > MAX_BYTES) throw bad('Your Drive is larger than 10 GB: download its folders from Drive instead (select them, then Download)');
    const zip = new JSZip();
    const used = new Set();
    const unique = (p) => { let x = p, i = 1; while (used.has(x.toLowerCase())) { const dot = p.lastIndexOf('.'); x = dot > p.lastIndexOf('/') ? `${p.slice(0, dot)} (${i})${p.slice(dot)}` : `${p} (${i})`; i++; } used.add(x.toLowerCase()); return x; };
    // Drive: your own files and folders, as they're arranged (anything inside someone else's folder goes at the top).
    const mine = q('SELECT * FROM files WHERE owner_id = ? AND trashed = 0').all(me);
    const byId = new Map(mine.map((f) => [f.id, f]));
    const pathOf = (f) => { const parts = []; let cur = f; for (let i = 0; cur && i < 64; i++) { parts.unshift(safe(cur.name)); cur = byId.get(cur.parent_id); } return parts.join('/'); };
    // Documents, spreadsheets and presentations as Word, Excel and PowerPoint, or OpenDocument (?format=odf, or the choice in Settings).
    const odf = (req.query.format || q('SELECT file_format FROM users WHERE id = ?').get(req.user.id)?.file_format) === 'odf';
    // What Drive knows about each file and folder besides its contents (stars, folder colours, descriptions, labels): Drive details.json.
    const starred = new Set(q('SELECT file_id FROM file_stars WHERE user_id = ?').all(me).map((r) => r.file_id));
    const labelsOf = new Map();
    for (const l of q('SELECT file_id, label FROM file_labels WHERE user_id = ? ORDER BY label').all(me)) labelsOf.set(l.file_id, [...(labelsOf.get(l.file_id) || []), l.label]);
    const details = [];
    // Forms' "(File uploads)" folders and what's in them keep their ids here, so responses can find their files again.
    const formFolders = new Set(q('SELECT files_folder FROM forms WHERE owner_id = ? AND files_folder IS NOT NULL').all(me).map((r) => r.files_folder));
    const detailFor = (f, where) => {
      const d = { path: where.slice('Drive/'.length), ...((formFolders.has(f.id) || formFolders.has(f.parent_id)) && { id: f.id }), ...(['doc', 'sheet', 'slides'].includes(f.kind) && { kind: f.kind }), ...(starred.has(f.id) && { starred: true }), ...(f.kind === 'folder' && f.color && { color: f.color }),
        ...(f.description && { description: f.description }), ...(labelsOf.has(f.id) && { labels: labelsOf.get(f.id) }) };
      if (Object.keys(d).length > 1) details.push(d);
    };
    for (const f of mine) {
      if (f.kind === 'folder') { zip.folder(`Drive/${pathOf(f)}`); detailFor(f, `Drive/${pathOf(f)}`); continue; }
      const ext = (odf ? { doc: '.odt', sheet: '.ods', slides: '.odp' } : { doc: '.docx', sheet: '.xlsx', slides: '.pptx' })[f.kind] || '';
      const where = unique(`Drive/${pathOf(f)}${ext && !f.name.toLowerCase().endsWith(ext) ? ext : ''}`);
      detailFor(f, where);
      if (f.kind === 'file') { if (f.storage) zip.file(where, fs.createReadStream(path.join(FILES_DIR, f.storage)), { binary: true }); continue; }
      if (CO_EDITED.includes(f.kind)) { saveNow(f.id); f.content = q('SELECT content FROM files WHERE id = ?').get(f.id)?.content; } // what's being typed right now
      const content = JSON.parse(f.content || '{}');
      const pictureData = async (fileId) => {
        const pic = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(fileId);
        return pic && /^image\//.test(pic.mime || '') && pic.owner_id === me ? { data: fs.readFileSync(path.join(FILES_DIR, pic.storage)), mime: pic.mime } : null;
      };
      try {
        const extra = officeExtras(f); // page setup and comments, as Drive's own download has them
        const buf = odf
          ? (f.kind === 'doc' ? await odtFromDoc(withoutSuggestions(content), f.name, { pictureData, ...extra }) : f.kind === 'sheet' ? await odsFromSheet(content, extra) : await odpFromDeck(content, { title: f.name, pictureData, ...extra }))
          : f.kind === 'doc' ? await wordFromDoc(withoutSuggestions(content), f.name, { pictureData, ...extra })
            : f.kind === 'sheet' ? await excelFromSheet(content, extra) : await powerPointFromDeck(content, { title: f.name, pictureData, ...extra });
        zip.file(where, buf);
      } catch (e) { zip.file(`${where}.error.txt`, `This file couldn't be converted: ${e.message}`); }
    }
    if (details.length) {
      const colors = q('SELECT label, color FROM file_label_colors WHERE user_id = ? ORDER BY label').all(me);
      zip.file('Drive details.json', `${JSON.stringify({ files: details, ...(colors.length && { label_colors: Object.fromEntries(colors.map((c) => [c.label, c.color])) }) }, null, 2)}\n`);
    }
    // Email: each folder as an .mbox file, written to a temporary folder first (removed once sent).
    let mailNote = 'Email: this server has no email.';
    let tmp = null;
    if (mailEnabled()) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'takeout-'));
      try {
        const boxes = await writeMailbox(who, tmp, { maxBytes: MAX_BYTES - bytes });
        for (const b of boxes) zip.file(unique(`Mail/${b.name}`), fs.createReadStream(b.file), { binary: true });
        mailNote = `Mail/         your email, a file for each folder (${boxes.reduce((n, b) => n + b.messages, 0)} messages), for Thunderbird, Apple Mail or another mail program`;
      } catch (e) {
        mailNote = e.tooLarge ? 'Email: too large to include here; copy it with a mail app (see Settings).' : 'Email: the mail server couldn\'t be reached, so it isn\'t included. Try again later, or copy it with a mail app (see Settings).';
      }
    }
    zip.file('Calendar.ics', exportCalendar(me));
    // Your other calendars (Personal, Family…): each event in Calendar.ics says which one it's in.
    { const cals = q('SELECT name, color, hidden FROM user_calendars WHERE owner_id = ? ORDER BY created_at, name').all(me); if (cals.length) zip.file('Calendars.json', `${JSON.stringify(cals.map((c) => ({ name: c.name, color: c.color, hidden: !!c.hidden })), null, 2)}\n`); }
    const evTemplates = eventTemplatesJson(me);
    if (evTemplates) zip.file('Calendar templates.json', evTemplates);
    { const nt = noteTemplatesJson(me); if (nt) zip.file('Note templates.json', nt); }
    { const b = bookingPagesJson(me); if (b) zip.file('Booking pages.json', b); }
    { const f = feedsJson(me); if (f) zip.file('Calendar subscriptions.json', f); }
    { const p = prefsJson(me); if (p) zip.file('Settings.json', p); }
    { const groups = groupsOf(me).map((g) => ({ name: g.name, members: g.members })); if (groups.length) zip.file('Contact groups.json', `${JSON.stringify(groups, null, 2)}\n`); }
    zip.file('Contacts.vcf', contactsToVcf(q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(me).map(withPhoto)));
    zip.file('Tasks.csv', `﻿${allListsCsv(me)}\r\n`); // every column a list's download has, so Import lists from CSV… restores them
    { const h = historyTable(me); if (h.length > 1) zip.file('Task history.csv', `\ufeff${h.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`); }
    if (q('SELECT 1 FROM task_time WHERE user_id = ? LIMIT 1').get(me)) zip.file('Time on tasks.csv', `\ufeff${myTimeCsv(me)}`);
    { const k = kudosCsv(me); if (k) zip.file('Thanks.csv', k); }
    zip.file('Notes.md', `# Notes\n\n${notesMarkdown(me)}`);
    // Each note on its own too, with its pictures, as Notes' Download (.zip) gives them (and Import notes… takes back).
    for (const e of await notesZipEntries(q('SELECT * FROM notes WHERE owner_id = ? AND trashed_at IS NULL ORDER BY archived, pinned DESC, position DESC').all(me))) {
      zip.file(`Notes/${e.path}`, e.data, { binary: typeof e.data !== 'string' });
    }
    zip.file('Comments.csv', `\ufeff${commentsCsv(me)}\r\n`);
    // Chat: each conversation you're in (direct messages, private channels, channels you've joined or written in), as text.
    const seenNames = new Set();
    const reader = q('SELECT * FROM users WHERE id = ?').get(me);
    for (const [where, content] of mailSettingsFiles(me, who.username)) zip.file(where, content);
    // Forms: each of yours, its questions and its responses.
    const formNames = new Set();
    for (const f of formsForExport(me)) {
      let base = safe(f.title), n = 1;
      while (formNames.has(base.toLowerCase())) base = `${safe(f.title)} (${++n})`;
      formNames.add(base.toLowerCase());
      zip.file(`Forms/${base} - questions.md`, f.questions);
      zip.file(`Forms/${base} - responses.csv`, f.csv);
      zip.file(`Forms/${base} - form.json`, f.json); // the whole form, for bringing it back in
    }
    const convs = conversationsOf(me);
    for (const { id } of convs) {
      try {
        const { title, messages } = conversationFor(id, reader);
        let base = safe(title.replace(/^#/, '')), n = 1;
        while (seenNames.has(base.toLowerCase())) base = `${safe(title.replace(/^#/, ''))} (${++n})`;
        seenNames.add(base.toLowerCase());
        zip.file(`Chat/${base}.txt`, conversationText(title, messages, { tz: String(req.query.tz || 'UTC') }));
      } catch { /* one it can no longer read */ }
    }
    // Meet: the chats kept from meetings you started or were in.
    const meetNames = new Set();
    for (const c of keptChatsOf(me)) {
      let base = safe(c.name), n = 1;
      while (meetNames.has(base.toLowerCase())) base = `${safe(c.name)} (${++n})`;
      meetNames.add(base.toLowerCase());
      zip.file(`Meet chats/${base}.txt`, c.text);
    }
    // Recently deleted lists, forms, booking pages, groups and rooms (still restorable, recyclebin.js), each with what it held.
    const binned = binExport(me);
    if (binned.length) zip.file('Recently deleted.json', JSON.stringify(binned, null, 2));
    zip.file('README.txt', [`Your Workspace data, ${new Date().toISOString().slice(0, 10)}`, '',
      `Drive/        your files and folders (${odf ? 'documents, spreadsheets and presentations as OpenDocument: .odt, .ods, .odp, for LibreOffice and others' : 'documents as Word, spreadsheets as Excel, presentations as PowerPoint'})`,
      'Calendar.ics  your events, for Outlook, Google Calendar or Apple Calendar',
      'Contacts.vcf  your contacts, for phones, Outlook, Gmail or Apple Contacts',
      'Contact groups.json  your contact groups and who is in each (if any)',
      'Booking pages.json   your booking pages (each comes back with a new link) (if any)',
      'Calendar subscriptions.json  the calendars you subscribe to by web address (if any)',
      'Settings.json  your own settings: working hours, world clocks, how Mail, Drive and Chat look and behave for you',
      'Drive details.json  stars, folder colours, descriptions and labels of your Drive’s files and folders',
      'Calendars.json  your calendars besides the main one, with their colours (each event in Calendar.ics says which it is in)',
      'Tasks.csv     your task lists, for a spreadsheet',
      'Task history.csv  who changed what on the tasks of your lists, oldest first',
      'Time on tasks.csv  the time you tracked or added on tasks, oldest first (if any)',
      'Thanks.csv    thank-yous you gave and were given (if any)',
      'Notes.md      your notes, all in one file',
      'Notes/        each note as Markdown with its pictures (Notes → Import notes… takes them back)',
      'Comments.csv  comments you wrote, and those on your files, for a spreadsheet',
      'Chat/         each conversation you are in, as text',
      'Forms/        each of your forms: its questions, its responses for a spreadsheet, and the whole form (for bringing it back in)',
      'Meet chats/   the chat kept from meetings you started or were in (when its host kept it)',
      'Mail settings/ your filters (as Sieve, which most mail servers take), signatures, templates, vacation reply, labels and saved searches',
      'Calendar templates.json  your event templates, if you have any',
      'Note templates.json  your note templates, if you have any (Notes → Templates)',
      'Recently deleted.json  task lists, forms and the like you deleted in the last 30 days (or kept by a legal hold), with what each held', mailNote].join('\r\n'));
    audit(req, 'data.export', { target: who.username });
    const name = `Workspace data${who.id === req.user.id ? '' : ` ${who.username}`} ${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (tmp) res.on('close', () => fs.rm(tmp, { recursive: true, force: true }, () => {}));
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' }).on('error', (err) => res.destroy(err)).pipe(res);
  });
  return r;
}
