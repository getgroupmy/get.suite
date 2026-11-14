// Phishing reports: someone in a company marks an email as phishing (Mail → Report phishing). It's kept
// here for the company's admins (Admin → Phishing), grouped by sender, and they're told at once (a
// security notification, through the activity log) so they can warn everyone.
import { q } from './db.js';
import { uid, bad, notFound } from './util.js';

q(`CREATE TABLE IF NOT EXISTS phishing_reports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sender TEXT NOT NULL,              -- the From address, lower case
  subject TEXT,
  message_id TEXT,
  at INTEGER NOT NULL,
  handled_at INTEGER,                -- an admin has dealt with this sender
  handled_by TEXT REFERENCES users(id) ON DELETE SET NULL
)`).run();
q('CREATE INDEX IF NOT EXISTS phishing_org ON phishing_reports(org_id, sender)').run();

const domainOf = (a) => String(a).split('@')[1] || '';

/** Someone reports an email: { reports } (how many reports there now are for that sender), or { already } when they reported it before. */
export function recordPhishing(user, { from, subject, messageId }, at = Date.now()) {
  const sender = String(from || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(sender)) throw bad('That email has no sender to report');
  const mid = messageId ? String(messageId).slice(0, 500) : null;
  if (mid && q('SELECT 1 FROM phishing_reports WHERE org_id = ? AND user_id = ? AND message_id = ?').get(user.org_id, user.id, mid)) return { already: true, reports: countFor(user.org_id, sender) };
  q('INSERT INTO phishing_reports (id, org_id, user_id, sender, subject, message_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uid(), user.org_id, user.id, sender, subject ? String(subject).slice(0, 300) : null, mid, at);
  // A new report on a sender an admin had dealt with brings it back to their attention.
  q('UPDATE phishing_reports SET handled_at = NULL, handled_by = NULL WHERE org_id = ? AND sender = ?').run(user.org_id, sender);
  return { reports: countFor(user.org_id, sender) };
}
const countFor = (orgId, sender) => q('SELECT COUNT(*) AS n FROM phishing_reports WHERE org_id = ? AND sender = ?').get(orgId, sender).n;

/** A company's reports by sender, the ones still to deal with first, then the latest: who reported, how often, the subjects. */
export function phishingFor(orgId) {
  const rows = q(`SELECT p.*, u.name AS reporter, h.name AS handler FROM phishing_reports p LEFT JOIN users u ON u.id = p.user_id LEFT JOIN users h ON h.id = p.handled_by
                  WHERE p.org_id = ? ORDER BY p.at DESC`).all(orgId);
  const by = new Map();
  for (const r of rows) {
    let g = by.get(r.sender);
    if (!g) by.set(r.sender, g = { sender: r.sender, domain: domainOf(r.sender), reports: 0, people: [], subjects: [], first_at: r.at, last_at: r.at, handled_at: r.handled_at, handled_by: r.handler || null });
    g.reports += 1;
    g.first_at = Math.min(g.first_at, r.at);
    if (r.reporter && !g.people.includes(r.reporter)) g.people.push(r.reporter);
    if (r.subject && !g.subjects.includes(r.subject) && g.subjects.length < 5) g.subjects.push(r.subject);
  }
  return [...by.values()].sort((a, b) => (!!a.handled_at - !!b.handled_at) || b.last_at - a.last_at);
}

/** An admin has dealt with a sender's reports (or takes that back). */
export function setHandled(orgId, sender, adminId, handled = true, at = Date.now()) {
  const n = q('UPDATE phishing_reports SET handled_at = ?, handled_by = ? WHERE org_id = ? AND sender = ?')
    .run(handled ? at : null, handled ? adminId : null, orgId, String(sender || '').toLowerCase()).changes;
  if (!n) throw notFound('No reports for that sender');
}

// Senders blocked for everyone in a company: an address, or a whole domain (with its subdomains).
q(`CREATE TABLE IF NOT EXISTS org_blocked_senders (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  value TEXT NOT NULL,               -- a@b.com, or b.com
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, value)
)`).run();

/** What can be blocked: an address or a domain (with or without @ in front), lower case; or a reason it can't. */
export function blockValue(input, ownDomains = []) {
  const v = String(input || '').trim().toLowerCase().replace(/^@/, '');
  const address = /^[^\s@"\\]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/.exec(v);
  const domain = !v.includes('@') && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
  if (!address && !domain) throw bad('Give an email address (name@example.com) or a domain (example.com)');
  const dom = address ? address[1] : domain;
  if (ownDomains.some((d) => dom === d || dom.endsWith(`.${d}`))) throw bad('That’s your own company’s address: block it in a person’s filters instead');
  return v;
}
export const blockedFor = (orgId) => q(`SELECT b.value, b.added_at, u.name AS added_by FROM org_blocked_senders b LEFT JOIN users u ON u.id = b.added_by
                                        WHERE b.org_id = ? ORDER BY b.added_at DESC`).all(orgId);
/** Block it for everyone; the reports for it (an address, or every address at a domain) are then handled. */
export function addBlock(orgId, value, adminId, at = Date.now()) {
  q('INSERT OR IGNORE INTO org_blocked_senders (org_id, value, added_by, added_at) VALUES (?, ?, ?, ?)').run(orgId, value, adminId, at);
  const like = value.includes('@') ? value : `%@${value}`;
  q("UPDATE phishing_reports SET handled_at = ?, handled_by = ? WHERE org_id = ? AND handled_at IS NULL AND (sender LIKE ? OR sender LIKE ?)").run(at, adminId, orgId, like, value.includes('@') ? value : `%@%.${value}`);
}
export function removeBlock(orgId, value) {
  if (!q('DELETE FROM org_blocked_senders WHERE org_id = ? AND value = ?').run(orgId, String(value || '').toLowerCase()).changes) throw notFound('That isn’t blocked');
}
/** Every company's blocked senders (for the mail server's filters): org id → [values]. */
export function allBlocked() {
  const m = new Map();
  for (const b of q('SELECT org_id, value FROM org_blocked_senders ORDER BY value').all()) m.set(b.org_id, [...(m.get(b.org_id) || []), b.value]);
  return m;
}
