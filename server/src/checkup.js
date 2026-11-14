// Admin → Security checkup: a company's open security points at a glance, each with what to do and where.
// Items: { id, status: 'warn' | 'tip' | 'ok', title, detail, tab (the Admin tab that fixes it), people? }.
import { q } from './db.js';
import { activeForwarding } from './mail/forwarding.js';
import { mailEnabled } from './mail/config.js';
import { notify } from './notifications.js';

export const INACTIVE_DAYS = 90;
const names = (rows, n = 5) => rows.slice(0, n).map((r) => r.name || r.username).join(', ') + (rows.length > n ? ` and ${rows.length - n} more` : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The checkup. With email on, each of the company's domains is also looked up in DNS (SPF, DKIM, DMARC:
 * what stops others sending mail that looks like it's from you); `dns` replaces that lookup in tests.
 */
export async function checkup(orgId, at = Date.now(), { mail = mailEnabled(), dns = null } = {}) {
  const items = checkupNow(orgId, at);
  if (mail) {
    const lookup = dns || (await import('./routes/mailAdmin.js')).senderRecords;
    for (const d of q('SELECT name FROM domains WHERE org_id = ? ORDER BY created_at').all(orgId).map((x) => x.name)) {
      let recs;
      try { recs = await lookup(d); } catch { continue; }
      const missing = recs.filter((r) => !r.ok).map((r) => r.name);
      if (missing.length) {
        items.push({ id: `dns-${d}`, status: 'warn', title: `${d}: ${missing.join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} set up right`, detail: 'Without these DNS records, anyone can send email that looks like it comes from you, and your own mail is more likely to land in spam. Admin → Email shows the records to add.', tab: 'email' });
        continue;
      }
      const policy = /\bp=(\w+)/i.exec(recs.find((r) => r.name === 'DMARC')?.found?.[0] || '')?.[1]?.toLowerCase();
      if (policy === 'none') items.push({ id: `dmarc-${d}`, status: 'tip', title: `${d}: DMARC only reports forged mail`, detail: 'Its policy is p=none, so receivers still deliver mail forged in your name. Once the reports look right, change it to p=quarantine (or p=reject).', tab: 'email' });
      else items.push({ id: `dns-${d}`, status: 'ok', title: `${d}: SPF, DKIM and DMARC are set up`, detail: '', tab: 'email' });
    }
  }
  const rank = { warn: 0, tip: 1, ok: 2 };
  return items.sort((a, b) => rank[a.status] - rank[b.status]);
}

function checkupNow(orgId, at) {
  const org = q('SELECT * FROM orgs WHERE id = ?').get(orgId);
  const people = q(`SELECT u.id, u.name, u.username, u.is_admin, u.created_at,
                           MAX(COALESCE(u.last_active, 0), COALESCE((SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id), 0)) AS last_active,
                           EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) OR EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = u.id) AS strong
                    FROM users u WHERE u.org_id = ? AND u.disabled = 0 ORDER BY u.name COLLATE NOCASE`).all(orgId);
  const items = [];
  const add = (x) => items.push(x);

  // Admins first: their accounts open everything.
  const admins = people.filter((p) => p.is_admin);
  const weakAdmins = admins.filter((p) => !p.strong);
  add(weakAdmins.length
    ? { id: 'admin-2fa', status: 'warn', title: `${plural(weakAdmins.length, 'admin')} sign${weakAdmins.length === 1 ? 's' : ''} in with just a password`, detail: `${names(weakAdmins)}. Admins can change everything: they should turn on two-step verification or add a passkey (Settings).`, tab: 'users', people: weakAdmins.map((p) => p.name) }
    : { id: 'admin-2fa', status: 'ok', title: 'Every admin has two-step verification or a passkey', detail: '', tab: 'users' });
  if (admins.length > 3 && admins.length > people.length / 4) add({ id: 'admins', status: 'tip', title: `${plural(admins.length, 'admin')} in a company of ${people.length}`, detail: 'Fewer admins means fewer accounts that can change everything. Take admin rights from those who don’t need them.', tab: 'users' });

  // Everyone else.
  const weak = people.filter((p) => !p.strong);
  if (org?.require_2fa) add({ id: 'require-2fa', status: weak.length ? 'tip' : 'ok', title: 'Two-step verification is required', detail: weak.length ? `${plural(weak.length, 'person', 'people')} still ha${weak.length === 1 ? 's' : 've'} to set it up at their next sign-in.` : '', tab: 'company' });
  else add({ id: 'require-2fa', status: weak.length ? 'warn' : 'ok', title: weak.length ? `${plural(weak.length, 'person', 'people')} sign in with just a password` : 'Everyone has two-step verification or a passkey', detail: weak.length ? 'Require two-step verification for everyone (Company settings), so a guessed or leaked password isn’t enough.' : '', tab: 'company' });

  // Accounts nobody uses: a way in that nobody would notice.
  const stale = people.filter((p) => (p.last_active || p.created_at) < at - INACTIVE_DAYS * 864e5);
  if (stale.length) add({ id: 'inactive', status: 'warn', title: `${plural(stale.length, 'account')} not used for ${INACTIVE_DAYS} days`, detail: `${names(stale)}. Suspend the ones that are no longer needed: unused accounts are a way in nobody notices.`, tab: 'users', people: stale.map((p) => p.name) });

  // Mail going out by itself.
  const ours = new Set(q('SELECT name FROM domains WHERE org_id = ?').all(orgId).map((d) => d.name.toLowerCase()));
  const byId = new Map(people.map((p) => [p.id, p]));
  const outside = [...activeForwarding()].filter(([id, f]) => byId.has(id) && !ours.has(String(f.address).split('@')[1]?.toLowerCase()));
  if (outside.length) add({ id: 'forwarding', status: 'tip', title: `${plural(outside.length, 'person', 'people')} forward${outside.length === 1 ? 's' : ''} their mail outside the company`, detail: `${outside.slice(0, 5).map(([id, f]) => `${byId.get(id).name} → ${f.address}`).join('; ')}. If that isn’t wanted, untick outside forwarding in Company settings.`, tab: 'company' });

  // Files anyone with the link can open, for ever and without a password.
  const open = q(`SELECT COUNT(*) AS n FROM share_links l JOIN files f ON f.id = l.file_id JOIN users u ON u.id = l.created_by
                  WHERE u.org_id = ? AND l.expires_at IS NULL AND l.password_hash IS NULL AND COALESCE(l.mode, 'view') = 'view'`).get(orgId).n;
  if (open) add({ id: 'links', status: 'tip', title: `${plural(open, 'share link')} never expire${open === 1 ? 's' : ''} and ha${open === 1 ? 's' : 've'} no password`, detail: 'Anyone who gets the link can open the file for ever. Look through them in Share links, and set a longest life for new links in Company settings.', tab: 'links' });

  // Phishing reports nobody has dealt with.
  let reports = 0;
  try { reports = q('SELECT COUNT(DISTINCT sender) AS n FROM phishing_reports WHERE org_id = ? AND handled_at IS NULL').get(orgId).n; } catch { /* no reports table yet */ }
  if (reports) add({ id: 'phishing', status: 'warn', title: `${plural(reports, 'phishing report')} to look at`, detail: 'Warn everyone, block the sender or take their mail out of everyone’s Inbox.', tab: 'phishing' });

  // Settings worth having.
  if (!org?.mark_external) add({ id: 'mark-external', status: 'tip', title: 'Mail from outside the company isn’t marked', detail: 'Turn on Mark email from outside the company, so a message pretending to come from inside stands out.', tab: 'company' });
  if (!org?.session_idle_min) add({ id: 'idle', status: 'tip', title: 'People stay signed in while away', detail: 'Sign people out after some time without activity (Company settings), for shared or unattended computers.', tab: 'company' });

  const rank = { warn: 0, tip: 1, ok: 2 };
  return items.sort((a, b) => rank[a.status] - rank[b.status]);
}

// Once a week, a company with something needing attention tells its admins (a security notification).
q(`CREATE TABLE IF NOT EXISTS checkup_notices (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  sent_at INTEGER NOT NULL
)`).run();
export const NOTICE_EVERY_MS = 7 * 864e5;

/** Tell the admins of each company with warnings (at most weekly). Returns the companies told. */
export async function weeklyCheckupNotice(at = Date.now(), opts = {}) {
  const told = [];
  for (const org of q('SELECT id FROM orgs').all()) {
    const last = q('SELECT sent_at FROM checkup_notices WHERE org_id = ?').get(org.id)?.sent_at;
    if (last && at - last < NOTICE_EVERY_MS) continue;
    const warns = (await checkup(org.id, at, opts)).filter((x) => x.status === 'warn');
    if (!warns.length) continue;
    const admins = q('SELECT id FROM users WHERE org_id = ? AND is_admin = 1 AND disabled = 0').all(org.id).map((u) => u.id);
    if (!admins.length) continue;
    notify(admins, { kind: 'security', title: `Security checkup: ${warns.length} thing${warns.length === 1 ? '' : 's'} need${warns.length === 1 ? 's' : ''} attention`,
      body: warns.slice(0, 3).map((w) => w.title).join('; ') + (warns.length > 3 ? '; …' : ''), link: '/admin?tab=checkup' });
    q('INSERT INTO checkup_notices (org_id, sent_at) VALUES (?, ?) ON CONFLICT(org_id) DO UPDATE SET sent_at = excluded.sent_at').run(org.id, at);
    told.push(org.id);
  }
  return told;
}
