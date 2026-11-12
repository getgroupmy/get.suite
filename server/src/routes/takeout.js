// Download your data: everything you own in one .zip, in formats other programs open. Drive (with its
// folders; documents, spreadsheets and presentations as Word, Excel and PowerPoint, or OpenDocument), your calendar
// (.ics), contacts (.vcf), tasks (CSV), notes (Markdown) and email (an .mbox file per folder). Mounted at /api/takeout.
import { notesZipEntries } from './notes.js';
import { conversationFor } from './chat.js';
import { userSieve } from '../mail/sieve.js';
import { formsForExport } from './forms.js';
import { conversationText } from '../chatexport.js';
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mailEnabled } from '../mail/config.js';
import { writeMailbox, mailboxCounts } from '../mail/mbox.js';
import JSZip from 'jszip';
import { q, FILES_DIR } from '../db.js';
import { bad } from '../util.js';
import { audit } from '../audit.js';
import { forbidden, notFound } from '../util.js';
import { exportCalendar } from '../calimport.js';
import { contactsToVcf } from '../contactfiles.js';
import { withPhoto } from '../contactphotos.js';
import { wordFromDoc } from '../office/word.js';
import { odtFromDoc } from '../office/odt.js';
import { odsFromSheet } from '../office/ods.js';
import { odpFromDeck } from '../office/odp.js';
import { excelFromSheet } from '../office/excel.js';
import { powerPointFromDeck } from '../office/powerpoint.js';
import { withoutSuggestions } from '../office/suggestions.js';

const MAX_BYTES = 10 * 1024 ** 3; // stored files; beyond this, download Drive in parts
const safe = (name) => String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 150) || 'untitled';
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** Tasks as CSV rows (list, title, notes, due, time, done, for). */
export function tasksCsv(userId) {
  const rows = q(`SELECT l.name AS list, t.title, t.notes, t.due, t.due_time, t.done_at, u.name AS assignee, t.important
                  FROM tasks t JOIN task_lists l ON l.id = t.list_id LEFT JOIN users u ON u.id = t.assignee_id
                  WHERE l.owner_id = ? ORDER BY l.created_at, t.done_at IS NOT NULL, t.position`).all(userId);
  const head = ['List', 'Task', 'Notes', 'Due', 'Time', 'Done', 'For', 'Important'];
  return [head, ...rows.map((r) => [r.list, r.title, r.notes || '', r.due || '', r.due_time || '', r.done_at ? new Date(r.done_at).toISOString().slice(0, 10) : '', r.assignee || '', r.important ? 'yes' : ''])]
    .map((row) => row.map(csvCell).join(',')).join('\r\n');
}

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
    out.push(['Mail settings/filters.sieve', userSieve({ username, rules }) || '']);
    out.push(['Mail settings/filters.json', `${JSON.stringify(rules, null, 2)}\n`]);
  }
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

export default function takeoutRoutes() {
  const r = Router();
  // What's in it, before downloading.
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
  const whose = (req) => {
    if (!req.query.user || req.query.user === req.user.id) return { id: req.user.id, username: req.user.username };
    if (!req.user.is_admin) throw forbidden('Admins only');
    const u = q('SELECT id, org_id, username FROM users WHERE id = ?').get(String(req.query.user));
    if (!u || (u.org_id !== req.user.org_id && !req.user.is_super)) throw notFound('No such person');
    return u;
  };

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
    for (const f of mine) {
      if (f.kind === 'folder') { zip.folder(`Drive/${pathOf(f)}`); continue; }
      const ext = (odf ? { doc: '.odt', sheet: '.ods', slides: '.odp' } : { doc: '.docx', sheet: '.xlsx', slides: '.pptx' })[f.kind] || '';
      const where = unique(`Drive/${pathOf(f)}${ext && !f.name.toLowerCase().endsWith(ext) ? ext : ''}`);
      if (f.kind === 'file') { if (f.storage) zip.file(where, fs.createReadStream(path.join(FILES_DIR, f.storage)), { binary: true }); continue; }
      const content = JSON.parse(f.content || '{}');
      const pictureData = async (fileId) => {
        const pic = q("SELECT * FROM files WHERE id = ? AND kind = 'file' AND trashed = 0").get(fileId);
        return pic && /^image\//.test(pic.mime || '') && pic.owner_id === me ? { data: fs.readFileSync(path.join(FILES_DIR, pic.storage)), mime: pic.mime } : null;
      };
      try {
        const buf = odf
          ? (f.kind === 'doc' ? await odtFromDoc(withoutSuggestions(content), f.name, { pictureData }) : f.kind === 'sheet' ? await odsFromSheet(content) : await odpFromDeck(content, { title: f.name, pictureData }))
          : f.kind === 'doc' ? await wordFromDoc(withoutSuggestions(content), f.name, { pictureData })
            : f.kind === 'sheet' ? await excelFromSheet(content) : await powerPointFromDeck(content, { title: f.name, pictureData });
        zip.file(where, buf);
      } catch (e) { zip.file(`${where}.error.txt`, `This file couldn't be converted: ${e.message}`); }
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
    const evTemplates = eventTemplatesJson(me);
    if (evTemplates) zip.file('Calendar templates.json', evTemplates);
    zip.file('Contacts.vcf', contactsToVcf(q('SELECT * FROM contacts WHERE owner_id = ? ORDER BY name COLLATE NOCASE').all(me).map(withPhoto)));
    zip.file('Tasks.csv', `﻿${tasksCsv(me)}\r\n`);
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
    zip.file('README.txt', [`Your Workspace data, ${new Date().toISOString().slice(0, 10)}`, '',
      `Drive/        your files and folders (${odf ? 'documents, spreadsheets and presentations as OpenDocument: .odt, .ods, .odp, for LibreOffice and others' : 'documents as Word, spreadsheets as Excel, presentations as PowerPoint'})`,
      'Calendar.ics  your events, for Outlook, Google Calendar or Apple Calendar',
      'Contacts.vcf  your contacts, for phones, Outlook, Gmail or Apple Contacts',
      'Tasks.csv     your task lists, for a spreadsheet',
      'Notes.md      your notes, all in one file',
      'Notes/        each note as Markdown with its pictures (Notes → Import notes… takes them back)',
      'Comments.csv  comments you wrote, and those on your files, for a spreadsheet',
      'Chat/         each conversation you are in, as text',
      'Forms/        each of your forms: its questions, and its responses for a spreadsheet',
      'Mail settings/ your filters (as Sieve, which most mail servers take), signatures, templates and vacation reply',
      'Calendar templates.json  your event templates, if you have any', mailNote].join('\r\n'));
    audit(req, 'data.export', { target: who.username });
    const name = `Workspace data${who.id === req.user.id ? '' : ` ${who.username}`} ${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (tmp) res.on('close', () => fs.rm(tmp, { recursive: true, force: true }, () => {}));
    zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' }).on('error', (err) => res.destroy(err)).pipe(res);
  });
  return r;
}
