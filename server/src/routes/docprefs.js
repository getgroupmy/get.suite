// Writing preferences for Docs, kept per person so they follow you between devices: whether typing is
// autocorrected (smart quotes, dashes, arrows, ©, ½…) and your own replacements ("addr" → your address).
import { Router } from 'express';
import { q } from '../db.js';
import { bad } from '../util.js';

if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'doc_prefs')) q('ALTER TABLE users ADD COLUMN doc_prefs TEXT').run();

export const MAX_SUBS = 100;
const DEFAULTS = { autocorrect: true, subs: [] };

/** Preferences as stored: autocorrect on or off, and up to 100 replacements { from, to } (from: 1–40 characters, no spaces). */
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
  return { autocorrect: p?.autocorrect !== false, subs };
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
