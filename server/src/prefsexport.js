// Your own settings in Download your data (Settings.json), and back in again: working and quiet hours, world clocks,
// the second time zone, what downloads become, how Mail, Drive, Docs and Chat look and behave for you, the daily
// digest, and Notes' and Contacts' own choices (with note label colours). Only your choices: nothing about your
// account (name, address, password, admin, storage) or your company. Bringing it in sets a setting only where
// you haven't changed it here yet, so nothing you've already chosen is overwritten.
import { q } from './db.js';
import { readHours } from './workhours.js';
import { LABEL_COLORS } from './routes/notes.js';

// Settings read back through the same checks the app's own settings use.
const CHECK = {
  work_hours: (v) => JSON.stringify(readHours(JSON.parse(v))),
  file_format: (v) => (['office', 'odf'].includes(v) ? v : undefined),
  world_clocks: (v) => { const z = JSON.parse(v); if (!Array.isArray(z) || z.length > 8) return undefined; z.forEach((x) => new Intl.DateTimeFormat('en', { timeZone: String(x) })); return v; },
  second_tz: (v) => { new Intl.DateTimeFormat('en', { timeZone: v }); return v; },
  digest_tz: (v) => { new Intl.DateTimeFormat('en', { timeZone: v }); return v; },
};

const USER_PREFS = ['work_hours', 'quiet_hours', 'start_page', 'second_tz', 'cal_prefs', 'ring_off', 'keys_off', 'mail_tips_off', 'search_tips_off', 'mail_advance', 'mail_reply',
  'mail_read_after', 'mail_style', 'mail_pane', 'mail_list_width', 'mail_list', 'world_clocks', 'file_format', 'drive_view', 'home_layout', 'convert_uploads', 'doc_prefs', 'chat_email',
  'chat_email_wait', 'hide_reads', 'chat_keywords', 'hide_views', 'notify_off', 'mail_tidy_days', 'mail_attach', 'mail_nudges', 'inbox_tabs', 'digest_hour', 'digest_tz', 'digest_weekdays',
  'digest_off', 'digest_skip_empty', 'workloc_week', 'focus_quiet', 'plus_folders'];
const MAX_TEXT = 20000;

const columns = () => {
  const have = new Map(q('PRAGMA table_info(users)').all().map((c) => [c.name, c]));
  return USER_PREFS.filter((k) => have.has(k)).map((k) => have.get(k));
};
/** The column's default as a value (null when none). */
const defaultOf = (c) => {
  if (c.dflt_value === null || c.dflt_value === undefined) return null;
  const v = String(c.dflt_value);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
};
const tableHas = (t) => !!q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

/** Settings.json's text: only what you've changed from the default (null when nothing). */
export function prefsJson(userId) {
  const row = q('SELECT * FROM users WHERE id = ?').get(userId) || {};
  const user = {};
  for (const c of columns()) if (row[c.name] !== null && row[c.name] !== undefined && row[c.name] !== defaultOf(c)) user[c.name] = row[c.name];
  const out = { settings: user };
  if (tableHas('note_prefs')) { const n = q('SELECT view, sort FROM note_prefs WHERE user_id = ?').get(userId); if (n) out.notes = { ...n }; }
  if (tableHas('note_label_colors')) { const l = q('SELECT label, color FROM note_label_colors WHERE user_id = ? ORDER BY label').all(userId); if (l.length) out.note_label_colors = Object.fromEntries(l.map((r) => [r.label, r.color])); }
  if (tableHas('contact_prefs')) { const c = q('SELECT sort, remind, remind_tz FROM contact_prefs WHERE user_id = ?').get(userId); if (c) out.contacts = { ...c }; }
  if (!Object.keys(user).length && Object.keys(out).length === 1) return null;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** A value fit for a column: a number or short text (text that looks like JSON must be JSON), else undefined. */
function fit(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string' || v.length > MAX_TEXT) return undefined;
  if (/^\s*[[{]/.test(v)) { try { JSON.parse(v); } catch { return undefined; } }
  return v;
}

/** Brings settings back in: { added } (how many were set). */
export function importPrefs(userId, data) {
  if (!data || typeof data !== 'object') return { added: 0 };
  let added = 0;
  const row = q('SELECT * FROM users WHERE id = ?').get(userId) || {};
  const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
  for (const c of columns()) {
    if (!(c.name in s)) continue;
    let v = fit(s[c.name]);
    if (v !== undefined && CHECK[c.name]) { try { v = CHECK[c.name](v); } catch { v = undefined; } }
    if (v === undefined || (row[c.name] !== null && row[c.name] !== defaultOf(c))) continue; // already chosen here
    if (typeof v !== 'number' && /INT/i.test(c.type)) continue;
    q(`UPDATE users SET ${c.name} = ? WHERE id = ?`).run(v, userId);
    added++;
  }
  if (data.notes && tableHas('note_prefs') && !q('SELECT 1 FROM note_prefs WHERE user_id = ?').get(userId)) {
    const view = fit(data.notes.view), sort = fit(data.notes.sort);
    if (['grid', 'list'].includes(view)) { q('INSERT INTO note_prefs (user_id, view, sort) VALUES (?, ?, ?)').run(userId, view, ['mine', 'edited', 'created', 'title'].includes(sort) ? sort : 'mine'); added++; }
  }
  if (data.note_label_colors && typeof data.note_label_colors === 'object' && tableHas('note_label_colors')) {
    for (const [label, color] of Object.entries(data.note_label_colors).slice(0, 200)) {
      if (!LABEL_COLORS.includes(color) || !String(label).trim()) continue;
      if (q('INSERT INTO note_label_colors (user_id, label, color) VALUES (?, ?, ?) ON CONFLICT(user_id, label) DO NOTHING').run(userId, String(label).slice(0, 50), String(color)).changes) added++;
    }
  }
  if (data.contacts && tableHas('contact_prefs') && !q('SELECT 1 FROM contact_prefs WHERE user_id = ?').get(userId)) {
    const sort = fit(data.contacts.sort), remind = fit(data.contacts.remind), tz = fit(data.contacts.remind_tz);
    if (typeof sort === 'string') {
      try { q('INSERT INTO contact_prefs (user_id, sort, remind, remind_tz) VALUES (?, ?, ?, ?)').run(userId, sort.slice(0, 20), typeof remind === 'string' ? remind.slice(0, 200) : null, typeof tz === 'string' ? tz.slice(0, 64) : null); added++; } catch { /* a shape this server doesn't take */ }
    }
  }
  return { added };
}
