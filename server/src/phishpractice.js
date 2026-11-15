// Phishing practice (Admin → Phishing → Practice emails): an admin sends chosen colleagues a realistic
// practice phishing email. Clicking its link opens a page saying it was practice and what to look for;
// reporting it (Mail → Report phishing) is the right answer. The admin sees, per person, who clicked and
// who reported. Sent from the admin's own address under a made-up name, as such emails often are.
import crypto from 'node:crypto';
import { q } from './db.js';
import { uid, bad } from './util.js';
import { smtpFor } from './mail/imap.js';

q(`CREATE TABLE IF NOT EXISTS phish_practice (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sent_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  template TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`).run();
q(`CREATE TABLE IF NOT EXISTS phish_practice_people (
  practice_id TEXT NOT NULL REFERENCES phish_practice(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  sent_at INTEGER, clicked_at INTEGER, reported_at INTEGER, error TEXT,
  PRIMARY KEY (practice_id, user_id)
)`).run();

/** The practice emails to choose from: what they pretend to be. */
export const TEMPLATES = {
  password: { name: 'Password expiring', from: 'IT Helpdesk', subject: 'Action required: your password expires today',
    text: (link) => `Hello,\n\nYour email password expires today. To keep your mailbox working, confirm your password within 24 hours:\n\n${link}\n\nIf you don't, your account will be suspended.\n\nIT Helpdesk` },
  document: { name: 'Shared document', from: 'Document Share', subject: 'A document has been shared with you: Q4 salary review.xlsx',
    text: (link) => `A document has been shared with you.\n\nQ4 salary review.xlsx\n\nOpen it here: ${link}\n\nThis link expires in 48 hours.` },
  invoice: { name: 'Overdue invoice', from: 'Accounts Receivable', subject: 'Overdue invoice INV-20931: payment needed today',
    text: (link) => `Dear customer,\n\nOur records show invoice INV-20931 (RM 4,860.00) is 30 days overdue. Please review and pay it today to avoid a late fee:\n\n${link}\n\nAccounts Receivable` },
};
/**
 * An admin's own practice email: { from (the made-up name), subject, text with {link} where the link goes }.
 * Plain text only; the link is added at the end when {link} is missing.
 */
export function customTemplate(c) {
  const from = String(c?.from || '').replace(/[<>"\r\n]/g, '').trim().slice(0, 60);
  const subject = String(c?.subject || '').replace(/[\r\n]/g, ' ').trim().slice(0, 200);
  const body = String(c?.text || '').replace(/\r/g, '').trim().slice(0, 5000);
  if (!from) throw bad('Give the name it pretends to be from');
  if (!subject) throw bad('Give it a subject');
  if (!body) throw bad('Write the email');
  return { name: `Custom: ${subject.slice(0, 60)}`, from, subject, text: (link) => (body.includes('{link}') ? body.split('{link}').join(link) : `${body}\n\n${link}`) };
}

const MID = /^<?practice\.([A-Za-z0-9_-]{20,})@workspace>?$/;

/** Send a practice email to these people (in the admin's company). → { id, sent, failed } */
export async function sendPractice(admin, { template, userIds, base, custom = null }, { send = null } = {}) {
  const t = template === 'custom' ? customTemplate(custom) : TEMPLATES[template];
  if (!t) throw bad('Choose which practice email to send');
  const people = q(`SELECT id, username, name FROM users WHERE org_id = ? AND disabled = 0 AND id IN (SELECT value FROM json_each(?))`).all(admin.org_id, JSON.stringify(userIds || []));
  if (!people.length) throw bad('Choose who gets it');
  if (people.length > 500) throw bad('At most 500 people at a time');
  const id = uid(), at = Date.now();
  q('INSERT INTO phish_practice (id, org_id, sent_by, template, subject, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, admin.org_id, admin.id, template, t.subject, at);
  const mailer = send || ((m) => smtpFor(admin).sendMail(m));
  let sent = 0, failed = 0;
  for (const p of people) {
    const token = crypto.randomBytes(18).toString('base64url');
    q('INSERT INTO phish_practice_people (practice_id, user_id, token) VALUES (?, ?, ?)').run(id, p.id, token);
    const link = `${String(base).replace(/\/$/, '')}/practice/${token}`;
    try {
      await mailer({ from: { name: t.from, address: admin.username }, to: p.username, subject: t.subject, text: t.text(link), messageId: `<practice.${token}@workspace>` });
      q('UPDATE phish_practice_people SET sent_at = ? WHERE token = ?').run(Date.now(), token); sent++;
    } catch (e) { q('UPDATE phish_practice_people SET error = ? WHERE token = ?').run(String(e.message || e).slice(0, 200), token); failed++; }
  }
  return { id, sent, failed };
}

/** Someone clicked a practice link. → { name, template } (for the page), or null. */
export function practiceClicked(token) {
  const r = q('SELECT pp.*, p.template, u.name FROM phish_practice_people pp JOIN phish_practice p ON p.id = pp.practice_id JOIN users u ON u.id = pp.user_id WHERE pp.token = ?').get(String(token || ''));
  if (!r) return null;
  if (!r.clicked_at) q('UPDATE phish_practice_people SET clicked_at = ? WHERE token = ?').run(Date.now(), r.token);
  return { name: r.name, template: r.template };
}

/** A report of a practice email (by its Message-ID, from the person it was sent to): true when it was one. */
export function practiceReported(user, messageId) {
  const m = MID.exec(String(messageId || '').trim());
  if (!m) return false;
  const r = q('SELECT token, reported_at FROM phish_practice_people WHERE token = ? AND user_id = ?').get(m[1], user.id);
  if (!r) return false;
  if (!r.reported_at) q('UPDATE phish_practice_people SET reported_at = ? WHERE token = ?').run(Date.now(), r.token);
  return true;
}

/** A company's practice rounds, newest first, with each person's result. */
export function practiceFor(orgId) {
  return q('SELECT p.*, u.name AS sent_by_name FROM phish_practice p LEFT JOIN users u ON u.id = p.sent_by WHERE p.org_id = ? ORDER BY p.created_at DESC LIMIT 50').all(orgId).map((p) => {
    const people = q('SELECT pp.user_id, pp.sent_at, pp.clicked_at, pp.reported_at, pp.error, u.name, u.username FROM phish_practice_people pp JOIN users u ON u.id = pp.user_id WHERE pp.practice_id = ? ORDER BY u.name').all(p.id);
    return { id: p.id, template: p.template, name: TEMPLATES[p.template]?.name || (p.template === 'custom' ? `Custom: ${p.subject.slice(0, 60)}` : p.template), subject: p.subject, created_at: p.created_at, sent_by: p.sent_by_name,
      sent: people.filter((x) => x.sent_at).length, clicked: people.filter((x) => x.clicked_at).length, reported: people.filter((x) => x.reported_at).length,
      people: people.map((x) => ({ id: x.user_id, name: x.name, email: x.username, sent: !!x.sent_at, error: x.error, clicked_at: x.clicked_at, reported_at: x.reported_at })) };
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** The page a practice link opens. */
export function practicePage(found) {
  const tips = ['The sender’s name didn’t match its address (look at the address, not the name).', 'It was urgent, with a threat (suspended, late fee, expires today): pressure to act before thinking.',
    'It asked you to click a link to sign in, pay or open something you weren’t expecting.', 'Workspace never asks for your password by email; real shared files show in Drive.'];
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>This was a practice phishing email</title>
<body style="font:16px/1.55 system-ui,sans-serif;max-width:600px;margin:8vh auto;padding:0 16px;color:#1f1f1f;background:#fff">
<h1 style="font-size:24px">This was a practice phishing email</h1>
<p>${found ? `Don’t worry, ${esc(found.name)}: ` : ''}your company’s admins sent it to help everyone spot the real thing. Nothing happened and nothing was taken.</p>
<h2 style="font-size:18px">What gave it away</h2><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
<p><strong>Next time:</strong> don’t click; use <strong>Report phishing</strong> on the message in Mail. That warns your admins, and in a practice round it counts as spotting it.</p>
</body></html>`;
}

// Automatic rounds (Admin → Phishing → Practice emails → Send automatically): every 1, 3 or 6 months, a
// random third of the company (at least one person) gets one of the ready-made practice emails, sent as the
// admin who turned it on. orgs.practice_every (months, 0 = off), practice_by (that admin).
for (const [col, type] of [['practice_every', 'INTEGER NOT NULL DEFAULT 0'], ['practice_by', 'TEXT']]) {
  if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === col)) q(`ALTER TABLE orgs ADD COLUMN ${col} ${type}`).run();
}
export const EVERY_CHOICES = [0, 1, 3, 6];
export function setAutoPractice(admin, months) {
  const m = Number(months);
  if (!EVERY_CHOICES.includes(m)) throw bad('Every 1, 3 or 6 months, or never');
  q('UPDATE orgs SET practice_every = ?, practice_by = ? WHERE id = ?').run(m, m ? admin.id : null, admin.org_id);
  return autoPracticeOf(admin.org_id);
}
export function autoPracticeOf(orgId) {
  const o = q('SELECT practice_every, practice_by FROM orgs WHERE id = ?').get(orgId);
  const last = q('SELECT MAX(created_at) AS at FROM phish_practice WHERE org_id = ?').get(orgId)?.at || null;
  const every = o?.practice_every || 0;
  return { every, by: o?.practice_by ? q('SELECT name FROM users WHERE id = ?').get(o.practice_by)?.name || null : null, last_at: last, next_at: every ? (last || 0) + every * 30 * 864e5 : null };
}

/** Send the rounds that are due (checked every few hours). → the companies sent to. */
export async function autoPracticeTick(now = Date.now(), { base = process.env.PUBLIC_URL || '', send = null, pick = Math.random } = {}) {
  const done = [];
  for (const o of q('SELECT id, practice_every, practice_by FROM orgs WHERE practice_every > 0').all()) {
    const last = q('SELECT MAX(created_at) AS at FROM phish_practice WHERE org_id = ?').get(o.id)?.at || 0;
    if (now - last < o.practice_every * 30 * 864e5) continue;
    const admin = q('SELECT id, org_id, username FROM users WHERE id = ? AND org_id = ? AND disabled = 0').get(o.practice_by, o.id);
    if (!admin || !base) continue; // the admin left, or the server's address isn't known: wait
    const people = q('SELECT id FROM users WHERE org_id = ? AND disabled = 0').all(o.id).map((u) => u.id);
    for (let i = people.length - 1; i > 0; i--) { const j = Math.floor(pick() * (i + 1)); [people[i], people[j]] = [people[j], people[i]]; }
    const chosen = people.slice(0, Math.max(1, Math.round(people.length / 3)));
    const ids = Object.keys(TEMPLATES);
    try { await sendPractice(admin, { template: ids[Math.floor(pick() * ids.length)], userIds: chosen, base }, { send }); done.push(o.id); } catch (e) { console.error('[practice]', e.message); }
  }
  return done;
}
