// Admin → Security checkup: a company's open security points at a glance, each with what to do and where.
// Items: { id, status: 'warn' | 'tip' | 'ok', title, detail, tab (the Admin tab that fixes it), people? }.
import { q } from './db.js';
import { rulesOf } from './passwordrules.js';
import { activeForwarding } from './mail/forwarding.js';
import { mailEnabled, blockProgramsMap } from './mail/config.js';
import { notify } from './notifications.js';
import { externalShares } from './routes/externalshares.js';

export const INACTIVE_DAYS = 90;
const names = (rows, n = 5) => rows.slice(0, n).map((r) => r.name || r.username).join(', ') + (rows.length > n ? ` and ${rows.length - n} more` : '');
const FAILED_DAYS = 7, FAILED_MIN = 5; // "many failed sign-ins": 5 or more in a week
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The checkup. With email on, each of the company's domains is also looked up in DNS (SPF, DKIM, DMARC:
 * what stops others sending mail that looks like it's from you); `dns` replaces that lookup in tests.
 */
export async function checkup(orgId, at = Date.now(), { mail = mailEnabled(), dns = null } = {}) {
  const items = checkupNow(orgId, at);
  if (mail) {
    blockProgramsMap(); // (makes its column the first time)
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
    // Phishing practice: a round in the last six months, and who fell for the latest one.
    let last = null;
    try { last = q('SELECT id, created_at FROM phish_practice WHERE org_id = ? ORDER BY created_at DESC LIMIT 1').get(orgId); } catch { /* no table yet */ }
    if (!last || last.created_at < at - 182 * 864e5) {
      items.push({ id: 'practice', status: 'tip', title: last ? 'No phishing practice for six months' : 'No phishing practice yet', detail: 'Send a practice phishing email (Admin → Phishing → Practice emails): people learn to spot and report the real thing, and you see who needs a reminder.', tab: 'phishing' });
    } else {
      const fell = q('SELECT u.name, u.username FROM phish_practice_people pp JOIN users u ON u.id = pp.user_id WHERE pp.practice_id = ? AND pp.clicked_at IS NOT NULL AND pp.reported_at IS NULL AND u.disabled = 0 ORDER BY u.name').all(last.id);
      if (fell.length) items.push({ id: 'practice-clicked', status: 'tip', title: `${plural(fell.length, 'person', 'people')} clicked the latest practice phishing email`, detail: `${names(fell)}. They saw the practice page; a word with them, or another round later, helps it stick.`, tab: 'phishing', people: fell.map((p) => p.name) });
    }
    // Programs by email: refused at the door when the company says so.
    if (!q('SELECT block_programs FROM orgs WHERE id = ?').get(orgId)?.block_programs) {
      items.push({ id: 'block-programs', status: 'tip', title: 'Email with programs attached is let in', detail: 'Turn on Refuse email with programs or scripts attached (Company settings): .exe, .js, .iso and the like are a common way in, and there’s rarely a good reason to email them.', tab: 'company', fix: { label: 'Turn it on', settings: { block_programs: true } } });
    }
  }
  const rank = { warn: 0, tip: 1, ok: 2 };
  return items.sort((a, b) => rank[a.status] - rank[b.status]);
}

function checkupNow(orgId, at) {
  const org = q('SELECT * FROM orgs WHERE id = ?').get(orgId);
  const people = q(`SELECT u.id, u.name, u.username, u.is_admin, u.created_at,
                           MAX(COALESCE(u.last_active, 0), COALESCE((SELECT MAX(s.last_seen) FROM sessions s WHERE s.user_id = u.id), 0)) AS last_active,
                           EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) OR EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = u.id) AS strong, u.recovery_email
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
  else add({ id: 'require-2fa', status: weak.length ? 'warn' : 'ok', title: weak.length ? `${plural(weak.length, 'person', 'people')} sign in with just a password` : 'Everyone has two-step verification or a passkey', detail: weak.length ? 'Require two-step verification for everyone (Company settings), so a guessed or leaked password isn’t enough.' : '', tab: 'company', ...(weak.length && { fix: { label: 'Require two-step verification', settings: { require_2fa: true } }, remind: 'two-step' }) });

  // Accounts nobody uses: a way in that nobody would notice.
  const stale = people.filter((p) => (p.last_active || p.created_at) < at - INACTIVE_DAYS * 864e5);
  if (stale.length) add({ id: 'inactive', status: 'warn', title: `${plural(stale.length, 'account')} not used for ${INACTIVE_DAYS} days`, detail: `${names(stale)}. Suspend the ones that are no longer needed: unused accounts are a way in nobody notices.`, tab: 'users', people: stale.map((p) => p.name), ids: stale.map((p) => p.id) });

  // Signed in with a password known from data breaches (the company's rule): they're choosing a new one.
  const leaked = q('SELECT id, name, username FROM users WHERE org_id = ? AND disabled = 0 AND pw_leaked IS NOT NULL ORDER BY name').all(orgId);
  if (leaked.length) add({ id: 'leaked', status: 'warn', title: `${plural(leaked.length, 'person', 'people')} signed in with a password known from data breaches`, detail: `${names(leaked)}. They’re asked to choose a new one before going on; until they do, anyone with that password could try it on their phone or mail app too. Reset it for them if they don’t sign in soon.`, tab: 'users', people: leaked.map((p) => p.name), ids: leaked.map((p) => p.id) });

  // Someone keeps trying their password: a guessing attempt (or a phone with an old password).
  const tries = q(`SELECT target, COUNT(*) AS n, MAX(at) AS last FROM audit_log WHERE org_id = ? AND action = 'sign-in.failed' AND at > ? GROUP BY target HAVING n >= ? ORDER BY n DESC`).all(orgId, at - FAILED_DAYS * 864e5, FAILED_MIN);
  const byName = new Map(people.map((p) => [p.username, p]));
  const tried = tries.filter((t) => byName.has(t.target)).map((t) => ({ ...byName.get(t.target), n: t.n }));
  if (tried.length) add({ id: 'failed-signins', status: 'warn', title: `${plural(tried.length, 'account')} had many failed sign-ins this week`, detail: `${tried.slice(0, 5).map((p) => `${p.name} (${p.n})`).join(', ')}${tried.length > 5 ? ` and ${tried.length - 5} more` : ''}. Someone may be guessing their password, or an old password is saved on a phone. Look at where the tries came from; if it wasn’t them, sign them out everywhere and reset their password.`, tab: 'activity', filter: 'sign-in.failed', people: tried.map((p) => p.name) });

  // No recovery address: no password reset by themselves, and no security emails outside Workspace.
  const noRecovery = people.filter((p) => !p.recovery_email);
  if (noRecovery.length) add({ id: 'recovery', status: 'tip', title: `${plural(noRecovery.length, 'person', 'people')} ha${noRecovery.length === 1 ? 's' : 've'} no recovery email`, detail: `${names(noRecovery)}. Without one they can’t reset a forgotten password themselves, and they aren’t emailed when their account signs in somewhere new or its password changes. Each adds one in Settings → Recovery email.`, tab: 'users', people: noRecovery.map((p) => p.name), remind: 'recovery' });

  // Mail going out by itself.
  const ours = new Set(q('SELECT name FROM domains WHERE org_id = ?').all(orgId).map((d) => d.name.toLowerCase()));
  const byId = new Map(people.map((p) => [p.id, p]));
  const outside = [...activeForwarding()].filter(([id, f]) => byId.has(id) && !ours.has(String(f.address).split('@')[1]?.toLowerCase()));
  if (outside.length) add({ id: 'forwarding', status: 'tip', title: `${plural(outside.length, 'person', 'people')} forward${outside.length === 1 ? 's' : ''} their mail outside the company`, detail: `${outside.slice(0, 5).map(([id, f]) => `${byId.get(id).name} → ${f.address}`).join('; ')}. If that isn’t wanted, untick outside forwarding in Company settings.`, tab: 'company' });

  // Files shared with people at other companies (worth a look now and then; editing ones first).
  const ext = externalShares(orgId, at);
  if (ext.length) {
    const files = new Set(ext.map((x) => x.file_id)), editable = new Set(ext.filter((x) => x.role === 'editor').map((x) => x.file_id));
    const companies = [...new Set(ext.map((x) => x.with_company || 'another company'))];
    add({ id: 'outside', status: 'tip', title: `${plural(files.size, 'file or folder', 'files and folders')} shared with people at ${plural(companies.length, 'other company', 'other companies')}`,
      detail: `${companies.slice(0, 5).join(', ')}${companies.length > 5 ? ` and ${companies.length - 5} more` : ''}${editable.size ? `; ${editable.size} of them they can edit` : ''}. Check they still need it: stop what’s finished.${org?.external_share_days ? '' : ' Shares with other companies don’t end by themselves: limit them to 90 days (Company settings), and new ones end on their own.'}`,
      tab: 'outside', ...(!org?.external_share_days && { fix: { label: 'Limit outside shares to 90 days', settings: { external_share_days: 90 } } }) });
  }

  // Files anyone with the link can open, for ever and without a password.
  const open = q(`SELECT COUNT(*) AS n FROM share_links l JOIN files f ON f.id = l.file_id JOIN users u ON u.id = l.created_by
                  WHERE u.org_id = ? AND l.expires_at IS NULL AND l.password_hash IS NULL AND COALESCE(l.mode, 'view') = 'view'`).get(orgId).n;
  if (open) add({ id: 'links', status: 'tip', title: `${plural(open, 'share link')} never expire${open === 1 ? 's' : ''} and ha${open === 1 ? 's' : 've'} no password`, detail: 'Anyone who gets the link can open the file for ever. Look through them in Share links, and set a longest life for new links in Company settings.', tab: 'links' });

  // Phishing reports nobody has dealt with.
  let reports = 0;
  try { reports = q('SELECT COUNT(DISTINCT sender) AS n FROM phishing_reports WHERE org_id = ? AND handled_at IS NULL').get(orgId).n; } catch { /* no reports table yet */ }
  if (reports) add({ id: 'phishing', status: 'warn', title: `${plural(reports, 'phishing report')} to look at`, detail: 'Warn everyone, block the sender or take their mail out of everyone’s Inbox.', tab: 'phishing' });

  // Settings worth having.
  if (!org?.mark_external) add({ id: 'mark-external', status: 'tip', title: 'Mail from outside the company isn’t marked', detail: 'Turn on Mark email from outside the company, so a message pretending to come from inside stands out.', tab: 'company', fix: { label: 'Turn it on', settings: { mark_external: true } } });
  { const pr = rulesOf(orgId); if (!pr.breached) add({ id: 'breached', status: 'tip', title: 'Passwords aren’t checked against data breaches', detail: 'Turn on Not one known from data breaches (Password rules), so passwords attackers already have are refused, and people who sign in with one choose a new one.', tab: 'company', fix: { label: 'Turn it on', settings: { password_rules: { ...pr, breached: true } } } }); }
  if (!org?.session_idle_min) add({ id: 'idle', status: 'tip', title: 'People stay signed in while away', detail: 'Sign people out after some time without activity (Company settings), for shared or unattended computers.', tab: 'company', fix: { label: 'Sign out after 8 hours away', settings: { session_idle_min: 480 } } });

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

/** What a reminder asks people to do: who gets it, and what it says. */
const REMINDERS = {
  recovery: {
    who: "SELECT id FROM users WHERE org_id = ? AND disabled = 0 AND (recovery_email IS NULL OR recovery_email = '')",
    note: { title: 'Add a recovery email to your account', body: 'A personal address (not this one) lets you reset a forgotten password yourself, and tells you if your account signs in somewhere new. Settings → Recovery email.' },
  },
  'two-step': {
    who: `SELECT u.id FROM users u WHERE u.org_id = ? AND u.disabled = 0
           AND NOT EXISTS (SELECT 1 FROM two_factor t WHERE t.user_id = u.id AND t.enabled = 1) AND NOT EXISTS (SELECT 1 FROM passkeys pk WHERE pk.user_id = u.id)`,
    note: { title: 'Protect your account with a second step', body: 'Turn on two-step verification or add a passkey (Settings), so a guessed or leaked password isn’t enough to get into your account.' },
  },
};
const lastRemind = new Map();
/** Remind everyone in a company who hasn't done it (a notification each), at most daily per kind. Returns how many were told. */
export function remind(orgId, kind, at = Date.now()) {
  const r = REMINDERS[kind];
  if (!r) throw Object.assign(new Error('Unknown reminder'), { status: 400 });
  const key = `${orgId}:${kind}`;
  if (lastRemind.get(key) > at - 864e5) throw Object.assign(new Error('They were reminded less than a day ago'), { status: 429 });
  const ids = q(r.who).all(orgId).map((u) => u.id);
  if (ids.length) notify(ids, { kind: 'signin', ...r.note, link: '/settings' });
  lastRemind.set(key, at);
  return ids.length;
}
export const remindRecovery = (orgId, at) => remind(orgId, 'recovery', at);
