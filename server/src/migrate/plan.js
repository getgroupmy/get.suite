// Moving here from another service: what to do with each file in its export .zip.
//   Google Takeout (Google Workspace or a Gmail account): Takeout/Mail/*.mbox, Calendar/*.ics, Contacts/**/*.vcf,
//     Drive/**, Keep/*.json (+ pictures), Tasks/Tasks.json. Other Google products (YouTube, Chrome…) are left out.
//   Microsoft 365 / Outlook.com: OneDrive's .zip download, contacts as .csv, calendars as .ics, mail as .eml or .mbox.
//   Zoho: Zoho Mail's export (.eml files in a folder per mail folder, or .mbox), Zoho Contacts (.vcf/.csv), Zoho
//     Calendar (.ics), WorkDrive's .zip download.
//   Notion: its Markdown & CSV export: pages to documents, databases to spreadsheets (see notion.js).
// Anything else in a non-Google export goes into Drive, keeping its folders.
import { isNotionExport, cleanNotionPath, notionSkip } from './notion.js';

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;
const GOOGLE_KNOWN = ['Mail', 'Calendar', 'Contacts', 'Drive', 'Keep', 'Tasks'];

/** Which service made the export, from the paths in it: 'google', 'microsoft', 'zoho', 'notion' or 'other'. */
export function sourceOf(names) {
  const all = names.join('\n');
  if (/(^|\n)Takeout\//.test(all) || /(^|\n)archive_browser\.html(\n|$)/.test(all)) return 'google';
  if (/(^|\n)(OneDrive|Outlook)([ _-][^/\n]*)?\//i.test(all) || /\.pst(\n|$)/i.test(all)) return 'microsoft';
  if (/(^|\n)(Zoho|WorkDrive)[^/\n]*\//i.test(all) || /zmail|zoho/i.test(all)) return 'zoho';
  if (isNotionExport(names)) return 'notion';
  return 'other';
}

/** The folder a file sits in ("Mail/Clients/x.eml" → "Clients"), without the export's own top folders. */
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const base = (p) => p.slice(p.lastIndexOf('/') + 1);

/** A CSV of contacts (Google, Outlook or Zoho's): its first line names email or name columns. */
export const contactsCsv = (firstLine) => /(^|,)"?(e-?mail( address| 1 - value)?|email address|first name|given name|display name|name)"?(,|$)/i.test(firstLine)
  && !/(^|,)"?(subject|start date|task|due)"?(,|$)/i.test(firstLine);

/**
 * What to do with each file: [{ name, as, path?, folder? }] where as is
 *   'mbox' (folder: the mail folder, or gmail: true for Gmail's all-mail file, split by its labels),
 *   'eml' (folder: the mail folder it was in), 'calendar', 'contacts', 'contacts-csv?' (a .csv to check),
 *   'keep', 'tasks' (Google Tasks' Tasks.json), 'drive' (path: where in the new Drive folder), or 'skip' (with why).
 * And { source, left_out } (Google products not brought in).
 */
export function planExport(names) {
  const files = names.filter((n) => !n.endsWith('/') && !JUNK.test(n));
  const source = sourceOf(files);
  // The export's own wrapping folder(s): "Takeout/", or a single top folder everything is in.
  let strip = '';
  if (source === 'google') strip = files.every((n) => n.startsWith('Takeout/')) ? 'Takeout/' : '';
  else {
    const tops = new Set(files.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/') + 1) : '')));
    if (tops.size === 1 && [...tops][0]) strip = [...tops][0];
  }
  const leftOut = new Set();
  const plan = files.map((name) => {
    const p = name.startsWith(strip) ? name.slice(strip.length) : name;
    const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : '';
    const ext = (/\.([a-z0-9]+)$/i.exec(p)?.[1] || '').toLowerCase();
    if (source === 'google') {
      if (p === 'archive_browser.html' || !top) return { name, as: 'skip', why: 'Google’s index page' };
      if (!GOOGLE_KNOWN.includes(top)) { leftOut.add(top); return { name, as: 'skip', why: 'not part of Workspace' }; }
      const rest = p.slice(top.length + 1);
      if (top === 'Mail') {
        if (ext !== 'mbox') return { name, as: 'skip', why: 'mail settings' };
        return /^all mail/i.test(base(rest)) ? { name, as: 'mbox', gmail: true } : { name, as: 'mbox', folder: base(rest).replace(/\.mbox$/i, '') };
      }
      if (top === 'Calendar') return ext === 'ics' ? { name, as: 'calendar' } : { name, as: 'skip', why: 'calendar settings' };
      if (top === 'Contacts') {
        // Every group is exported, each with the people in it: "All Contacts" has everyone, so only that (when it's there).
        const all = files.some((n) => /\/Contacts\/All Contacts\/[^/]+\.vcf$/i.test(n));
        if (ext !== 'vcf' && ext !== 'csv') return { name, as: 'skip', why: 'not contacts' };
        if (all && !/^All Contacts\//i.test(rest)) return { name, as: 'skip', why: 'in All Contacts too' };
        return { name, as: ext === 'vcf' ? 'contacts' : 'contacts-csv?' };
      }
      if (top === 'Keep') return ['json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'html'].includes(ext) && base(rest) !== 'Labels.txt' ? { name, as: 'keep' } : { name, as: 'skip', why: 'Keep’s label list' };
      if (top === 'Tasks') return ext === 'json' ? { name, as: 'tasks' } : { name, as: 'skip', why: 'not tasks' };
      return { name, as: 'drive', path: rest }; // Drive
    }
    if (source === 'notion') { // pages to documents, databases to spreadsheets, the rest (pictures, files) as they are
      if (notionSkip(name, files)) return { name, as: 'skip', why: 'the same database as its “_all” file' };
      const clean = cleanNotionPath(p);
      // A page with sub-pages goes in their folder (named like it): "Roadmap/Roadmap".
      if (ext === 'md') { const own = name.replace(/\.md$/i, '/'); const page = clean.replace(/\.md$/i, ''); return { name, as: 'drive', path: files.some((n) => n.startsWith(own)) ? `${page}/${page.slice(page.lastIndexOf('/') + 1)}` : page, convert: 'doc' }; }
      if (ext === 'csv') return { name, as: 'drive', path: clean.replace(/\.csv$/i, ''), convert: 'sheet' };
      return { name, as: 'drive', path: clean };
    }
    // Microsoft, Zoho and anything else: by kind of file.
    if (ext === 'mbox') return { name, as: 'mbox', folder: base(p).replace(/\.mbox$/i, '') };
    if (ext === 'eml') return { name, as: 'eml', folder: base(dirOf(p)) || 'Imported' };
    if (ext === 'ics') return { name, as: 'calendar' };
    if (ext === 'vcf') return { name, as: 'contacts' };
    if (ext === 'csv') return { name, as: 'contacts-csv?', path: p };
    if (ext === 'pst' || ext === 'ost') return { name, as: 'skip', why: 'Outlook data files (.pst) can’t be read here: export the mail over IMAP instead' };
    return { name, as: 'drive', path: p.replace(/^(OneDrive|WorkDrive)[^/]*\//i, '') };
  });
  return { source, plan, left_out: [...leftOut].sort() };
}

/**
 * Gmail's labels on one message (its X-Gmail-Labels header) → where it goes here: { folder } ('INBOX', '\\Sent',
 * '\\Drafts', '\\Archive' or a label's name), or { skip: true } for spam and trash. Read and starred come from the
 * same header elsewhere (Unread, Starred).
 */
export function gmailTarget(header) {
  const labels = String(header || '').split(',').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  const has = (l) => labels.some((x) => x.toLowerCase() === l);
  if (has('spam') || has('trash') || has('chat')) return { skip: true }; // Chat: old Hangouts conversations
  if (has('drafts') || has('draft')) return { folder: '\\Drafts' };
  if (has('inbox')) return { folder: 'INBOX' };
  if (has('sent')) return { folder: '\\Sent' };
  const SYSTEM = new Set(['opened', 'unread', 'starred', 'important', 'archived', 'chat', 'sent', 'inbox']);
  const own = labels.find((l) => !SYSTEM.has(l.toLowerCase()) && !/^category /i.test(l));
  return own ? { folder: own.replace(/[\r\n\t]/g, ' ').slice(0, 80) } : { folder: '\\Archive' };
}
