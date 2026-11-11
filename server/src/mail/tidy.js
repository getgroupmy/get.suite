// Tidying the inbox: mail in the Updates tab (newsletters, notifications, receipts) older than so many
// days moves to Archive by itself, once a day, for those who turn it on (Mail settings). Starred mail
// stays put, and so does anything moved to Primary by hand. Nothing is deleted.
import { q } from '../db.js';
import { withFolder, withClient } from './imap.js';
import { tabQuery } from './tabs.js';
import { allOf } from './searchquery.js';
import { mailEnabled } from './config.js';
import { sendTo } from '../hub.js';

for (const [col, type] of [['mail_tidy_days', 'INTEGER'], ['mail_tidy_last', 'TEXT']]) {
  if (!q('PRAGMA table_info(users)').all().some((c) => c.name === col)) q(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run();
}
export const TIDY_DAYS = [7, 14, 30, 60, 90];
const BATCH = 1000; // messages moved in one go (the rest the next day)

/** The IMAP search for what to tidy: in Updates, received more than `days` days before `now`, not starred. */
export function tidyQuery(days, now = Date.now()) {
  return allOf([tabQuery('updates'), { before: new Date(now - days * 864e5) }, { flagged: false }]);
}

/** Move someone's old Updates mail to Archive now. Returns how many moved. */
export async function tidyUser(user, days, now = Date.now()) {
  const archive = await withClient(user, async (c) => (await c.list()).find((b) => b.specialUse === '\\Archive')?.path || null);
  if (!archive) return 0;
  const moved = await withFolder(user, 'INBOX', async (c) => {
    const uids = ((await c.search(tidyQuery(days, now), { uid: true })) || []).slice(0, BATCH);
    if (uids.length) await c.messageMove(uids.join(','), archive, { uid: true });
    return uids.length;
  });
  if (moved) sendTo([user.id], { type: 'mail-tidied' });
  return moved;
}

const today = (t) => new Date(t).toISOString().slice(0, 10);
let running = false;
/** Once a day for each person who has it on. */
export async function runTidy(now = Date.now()) {
  if (running || !mailEnabled()) return 0;
  running = true;
  let n = 0;
  try {
    for (const u of q('SELECT * FROM users WHERE mail_tidy_days IS NOT NULL AND disabled = 0 AND (mail_tidy_last IS NULL OR mail_tidy_last != ?)').all(today(now))) {
      q('UPDATE users SET mail_tidy_last = ? WHERE id = ?').run(today(now), u.id); // once a day, even if it fails
      try { n += await tidyUser(u, u.mail_tidy_days, now); } catch (e) { console.error('[mail] tidy:', e.message); }
    }
  } finally { running = false; }
  return n;
}
export function scheduleTidy() { setInterval(() => runTidy().catch((e) => console.error('[mail] tidy:', e.message)), 3600e3).unref(); }

/** GET/PUT /mail/tidy ({ days: 7…90 | null }) and POST /mail/tidy/now (tidy straight away: { moved }). */
export function tidyRoutes(r) {
  r.get('/tidy', (req, res) => res.json({ days: q('SELECT mail_tidy_days AS d FROM users WHERE id = ?').get(req.user.id).d ?? null }));
  r.put('/tidy', (req, res) => {
    const d = req.body?.days;
    if (d !== null && !TIDY_DAYS.includes(d)) { res.status(400).json({ error: `Choose ${TIDY_DAYS.join(', ')} days, or off` }); return; }
    q('UPDATE users SET mail_tidy_days = ?, mail_tidy_last = NULL WHERE id = ?').run(d, req.user.id);
    res.json({ days: d });
  });
  r.post('/tidy/now', async (req, res) => {
    const d = q('SELECT mail_tidy_days AS d FROM users WHERE id = ?').get(req.user.id).d;
    if (!d) { res.status(400).json({ error: 'Turn tidying on first' }); return; }
    res.json({ moved: await tidyUser(req.user, d) });
  });
}
