// The forgotten-attachment reminder in Mail (Compose asks "Did you mean to attach something?"): each person
// can turn it off, and add words of their own that mean a file comes with the message (another language's,
// or the company's own: "spec sheet", "Anlage"). Kept as JSON in users.mail_attach: { off, words }.
import { q } from '../db.js';
import { bad } from '../util.js';

if (!q('PRAGMA table_info(users)').all().some((c) => c.name === 'mail_attach')) q('ALTER TABLE users ADD COLUMN mail_attach TEXT').run();
export const MAX_WORDS = 20;

/** The words as given (a list, or text with one per line or comma), tidied: trimmed, lower case, no repeats. Throws on bad ones. */
export function cleanWords(words) {
  const list = Array.isArray(words) ? words : String(words ?? '').split(/[\n,]/);
  const out = [];
  for (const w of list) {
    const s = String(w ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!s) continue;
    if (s.length < 2 || s.length > 40) throw bad(`“${s.slice(0, 40)}” should be 2 to 40 letters long`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > MAX_WORDS) throw bad(`Up to ${MAX_WORDS} words`);
  return out;
}

/** { on, words } for this person (on, with no words of their own, to begin with). */
export function attachPrefs(userId) {
  let v = {};
  try { v = JSON.parse(q('SELECT mail_attach FROM users WHERE id = ?').get(userId)?.mail_attach || '{}') || {}; } catch { /* as new */ }
  return { on: !v.off, words: Array.isArray(v.words) ? v.words : [] };
}

export function attachPrefRoutes(r) {
  r.get('/attach-check', (req, res) => res.json(attachPrefs(req.user.id)));
  r.put('/attach-check', (req, res) => {
    const was = attachPrefs(req.user.id);
    const on = req.body?.on === undefined ? was.on : req.body.on !== false;
    const words = req.body?.words === undefined ? was.words : cleanWords(req.body.words);
    q('UPDATE users SET mail_attach = ? WHERE id = ?').run(on && !words.length ? null : JSON.stringify({ ...(!on && { off: true }), ...(words.length && { words }) }), req.user.id);
    res.json({ on, words });
  });
}
