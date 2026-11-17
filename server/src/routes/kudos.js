// Thanks: a colleague says thank you (a few words and an emoji). The person thanked is told in the bell; it shows on
// their card (the most recent), and Home's "Thanks" card shows the company's latest. Only within a company.
// Mounted at /api/kudos.
import { Router } from 'express';
import { q } from '../db.js';
import { uid, now, str, bad, notFound } from '../util.js';
import { notify } from '../notifications.js';
import { sendTo } from '../hub.js';
import { channelChoice, postToChannel } from './chat.js';

q(`CREATE TABLE IF NOT EXISTS kudos (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS kudos_to ON kudos (to_id, created_at)').run();
// 👏: colleagues joining in on a thank-you (not its giver).
q(`CREATE TABLE IF NOT EXISTS kudos_claps (
  kudos_id TEXT NOT NULL REFERENCES kudos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kudos_id, user_id)
)`).run();
q('CREATE INDEX IF NOT EXISTS kudos_org ON kudos (org_id, created_at)').run();

export const KUDOS_EMOJI = ['🙌', '🎉', '💪', '🌟', '🙏', '🚀', '❤️', '🏆'];
const PER_DAY = 20; // thanks one person may give in a day

const SELECT = `SELECT k.id, k.emoji, k.message, k.created_at, k.from_id, f.name AS from_name, k.to_id, t.name AS to_name
  FROM kudos k JOIN users f ON f.id = k.from_id JOIN users t ON t.id = k.to_id`;
/** With its applause: how many, whether you're among them, and who (names, up to 10). */
const shape = (r, me) => {
  const claps = q('SELECT c.user_id, u.name FROM kudos_claps c JOIN users u ON u.id = c.user_id WHERE c.kudos_id = ? ORDER BY c.created_at').all(r.id);
  return { ...r, mine: r.from_id === me, claps: claps.length, clapped: claps.some((c) => c.user_id === me), clappers: claps.slice(0, 10).map((c) => c.name) };
};

/** The org's people get the new one live (Home's card, cards that are open). */
const tell = (orgId) => sendTo(q('SELECT id FROM users WHERE org_id IS ? AND disabled = 0').all(orgId).map((u) => u.id), { type: 'kudos-changed' });

export default function kudosRoutes() {
  const r = Router();
  // The company's latest (Home): ?limit (up to 50).
  r.get('/', (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    res.json(q(`${SELECT} WHERE k.org_id IS ? AND t.disabled = 0 ORDER BY k.created_at DESC LIMIT ?`).all(req.user.org_id, limit).map((x) => shape(x, req.user.id)));
  });
  // Someone's (their card): the latest 20 and how many in all.
  r.get('/for/:userId', (req, res) => {
    const u = q('SELECT id, org_id FROM users WHERE id = ?').get(String(req.params.userId));
    if (!u || u.org_id !== req.user.org_id) throw notFound('No such person');
    res.json({
      count: q('SELECT COUNT(*) AS n FROM kudos WHERE to_id = ?').get(u.id).n,
      latest: q(`${SELECT} WHERE k.to_id = ? ORDER BY k.created_at DESC LIMIT 20`).all(u.id).map((x) => shape(x, req.user.id)),
    });
  });
  // { to, message, emoji, channel_id? }: with a channel, it's also posted there, as you (a channel you can write in).
  r.post('/', (req, res) => {
    const to = q('SELECT id, org_id, name, disabled FROM users WHERE id = ?').get(String(req.body?.to || ''));
    if (!to || to.disabled || to.org_id !== req.user.org_id) throw notFound('No such person');
    if (to.id === req.user.id) throw bad('Thank someone else');
    const message = (str(req.body?.message, { max: 280, name: 'Message' }) || '').trim();
    if (!message) throw bad('Say what you’re thanking them for');
    const emoji = KUDOS_EMOJI.includes(req.body?.emoji) ? req.body.emoji : KUDOS_EMOJI[0];
    if (q('SELECT COUNT(*) AS n FROM kudos WHERE from_id = ? AND created_at > ?').get(req.user.id, now() - 864e5).n >= PER_DAY) throw bad('That’s a lot of thanks for one day; try again tomorrow');
    const channel = req.body?.channel_id ? channelChoice(req.body.channel_id, req.user) : null;
    const id = uid();
    q('INSERT INTO kudos (id, org_id, from_id, to_id, emoji, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, req.user.org_id, req.user.id, to.id, emoji, message, now());
    notify([to.id], { kind: 'kudos', title: `${emoji} ${req.user.name} thanked you`, body: message, link: '/home', actor: req.user.id });
    tell(req.user.org_id);
    if (channel) postToChannel(channel.id, req.user, `${emoji} Thanks, ${to.name}: ${message}`);
    res.status(201).json(shape(q(`${SELECT} WHERE k.id = ?`).get(id), req.user.id));
  });
  // 👏 on someone's thank-you, or off again: { on }.
  r.post('/:id/clap', (req, res) => {
    const k = q('SELECT * FROM kudos WHERE id = ?').get(String(req.params.id));
    if (!k || k.org_id !== req.user.org_id) throw notFound('Not found');
    if (k.from_id === req.user.id) throw bad('That’s your own thank-you');
    if (req.body?.on === false) q('DELETE FROM kudos_claps WHERE kudos_id = ? AND user_id = ?').run(k.id, req.user.id);
    else q('INSERT OR IGNORE INTO kudos_claps (kudos_id, user_id, created_at) VALUES (?, ?, ?)').run(k.id, req.user.id, now());
    tell(k.org_id);
    res.json(shape(q(`${SELECT} WHERE k.id = ?`).get(k.id), req.user.id));
  });
  // Take back your own.
  r.delete('/:id', (req, res) => {
    const k = q('SELECT * FROM kudos WHERE id = ? AND from_id = ?').get(String(req.params.id), req.user.id);
    if (!k) throw notFound('Not found');
    q('DELETE FROM kudos WHERE id = ?').run(k.id);
    tell(k.org_id);
    res.json({ ok: true });
  });
  return r;
}
