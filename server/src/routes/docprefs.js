// Writing preferences for Docs, kept per person so they follow you between devices: whether typing is
// autocorrected (smart quotes, dashes, arrows, ©, ½…) and your own replacements ("addr" → your address),
// how big documents are shown (zoom), and whether misspelt words are underlined.
import { Router } from 'express';
import { q } from '../db.js';
import { bad } from '../util.js';
import { readSetup } from '../pagesetup.js';

if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'doc_prefs')) q('ALTER TABLE users ADD COLUMN doc_prefs TEXT').run();

export const MAX_SUBS = 100;
export const ZOOMS = [50, 75, 90, 100, 110, 125, 150, 200];
// How the editor is laid out for you (null until chosen: then a browser's earlier choice is used, and kept here):
// the outline panel, typewriter scrolling, dimming other paragraphs, a writing sprint's quiet and status options,
// and the language voice typing listens for ('' for the browser's own).
const FLAGS = ['outline', 'typewriter', 'dim_others', 'sprint_quiet', 'sprint_status'];
const DEFAULTS = { autocorrect: true, subs: [], zoom: 100, spellcheck: true, sheet_zoom: 100, ...Object.fromEntries(FLAGS.map((k) => [k, null])), voice_lang: null };

/** Preferences as stored: autocorrect on or off, up to 100 replacements { from, to } (from: 1–40 characters, no
 *  spaces), the zoom (one of ZOOMS, in %) and spell check on or off; and the zoom for spreadsheets. */
export function cleanPrefs(p) {
  const subs = [];
  const seen = new Set();
  for (const s of Array.isArray(p?.subs) ? p.subs : []) {
    const from = String(s?.from ?? '').trim().slice(0, 40), to = String(s?.to ?? '').slice(0, 500);
    if (!from || /\s/.test(from) || !to || seen.has(from)) continue;
    seen.add(from);
    subs.push({ from, to });
    if (subs.length >= MAX_SUBS) break;
  }
  const zoomOf = (v) => (ZOOMS.includes(Number(v)) ? Number(v) : 100);
  // page_setup: the page setup your new documents start with (Page setup → Use for my new documents), or none.
  let setup = null;
  if (p?.page_setup && typeof p.page_setup === 'object') {
    const { wordGoal, ...rest } = readSetup(p.page_setup); // a word count goal is one document's
    setup = rest;
  }
  const flags = Object.fromEntries(FLAGS.map((k) => [k, typeof p?.[k] === 'boolean' ? p[k] : null]));
  const lang = typeof p?.voice_lang === 'string' && (p.voice_lang === '' || /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(p.voice_lang)) ? p.voice_lang : null;
  return { autocorrect: p?.autocorrect !== false, subs, zoom: zoomOf(p?.zoom), spellcheck: p?.spellcheck !== false, sheet_zoom: zoomOf(p?.sheet_zoom), ...flags, voice_lang: lang, ...(setup && { page_setup: setup }) };
}

export const prefsOf = (userId) => {
  const row = q('SELECT doc_prefs FROM users WHERE id = ?').get(userId);
  try { return row?.doc_prefs ? cleanPrefs(JSON.parse(row.doc_prefs)) : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; }
};

export default function docPrefRoutes() {
  const r = Router();
  r.get('/', (req, res) => res.json(prefsOf(req.user.id)));
  r.put('/', (req, res) => {
    if (!req.body || typeof req.body !== 'object') throw bad('Preferences expected');
    const p = cleanPrefs({ ...prefsOf(req.user.id), ...req.body });
    q('UPDATE users SET doc_prefs = ? WHERE id = ?').run(JSON.stringify(p), req.user.id);
    res.json(p);
  });
  return r;
}
