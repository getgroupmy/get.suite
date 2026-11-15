// "Outside the company" in Compose: which of a message's recipients aren't on one of the company's own
// domains, and which of those you've never written to (or kept as a contact), so a message going
// somewhere new is noticed before it leaves.
import { siteOf } from './linkcheck.js';
import { q } from '../db.js';
import { lookalikeOf } from './lookalike.js';

const clean = (e) => String(e || '').trim().toLowerCase();

// orgs.ask_outside: 1 when the company wants Mail to ask before a message goes outside it (Admin → Company settings).
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'ask_outside')) q('ALTER TABLE orgs ADD COLUMN ask_outside INTEGER NOT NULL DEFAULT 0').run();
// orgs.mark_external: 1 when mail from outside the company gets a warning above it (Admin → Company settings).
if (!q('PRAGMA table_info(orgs)').all().some((c) => c.name === 'mark_external')) q('ALTER TABLE orgs ADD COLUMN mark_external INTEGER NOT NULL DEFAULT 0').run();

const nameKey = (s) => String(s || '').normalize('NFKC').replace(/["'“”‘’]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
/**
 * A warning for an email someone received: null for mail from the company's own domains; otherwise
 * { company, external (the company marks outside mail), lookalike (the name of a colleague the sender
 * calls themselves, from an outside address), domain_like ({ domain, kind: 'company' | 'known' }: a domain
 * the sender's imitates, the company's own or one you write to), address }, or null when there's nothing to say.
 */
export function incomingWarning(user, from) {
  const address = clean(from?.address);
  const domain = address.split('@')[1];
  if (!domain) return null;
  const ours = q('SELECT name FROM domains WHERE org_id = ?').all(user.org_id).map((d) => d.name.toLowerCase());
  if (ours.includes(domain)) return null;
  const org = q('SELECT name, mark_external FROM orgs WHERE id = ?').get(user.org_id);
  const key = nameKey(from?.name);
  const colleague = key.length >= 3 ? q('SELECT name FROM users WHERE org_id = ? AND disabled = 0').all(user.org_id).find((u) => nameKey(u.name) === key) : null;
  const like = lookalikeDomain(user, domain, ours);
  if (!org?.mark_external && !colleague && !like) return null;
  return { company: org?.name || '', external: !!org?.mark_external, lookalike: colleague?.name || null, domain_like: like, address };
}

/**
 * Replies to this email would go to a different site than it came from (its Reply-To), a trick in invoice
 * fraud: the From looks right, the answer goes to the fraudster. → { from, reply_to } or null. Not for
 * mailing lists (which often answer elsewhere), a Reply-To on the company's own domains, or an address
 * you already write to or keep in Contacts.
 */
export function replyToWarning(user, from, replyTo, { list = false } = {}) {
  const sender = clean(from?.address);
  const fromSite = siteOf(sender.split('@')[1] || '');
  if (list || !fromSite) return null;
  const ours = q('SELECT name FROM domains WHERE org_id = ?').all(user.org_id).map((d) => d.name.toLowerCase());
  for (const r of replyTo || []) {
    const a = clean(r?.address);
    const d = a.split('@')[1];
    if (!d || siteOf(d) === fromSite || ours.includes(d)) continue;
    if (q('SELECT 1 FROM mail_sent_to WHERE owner_id = ? AND email = ?').get(user.id, a) || q('SELECT 1 FROM contacts WHERE owner_id = ? AND lower(email) = ?').get(user.id, a)) continue;
    return { from: sender, reply_to: a };
  }
  return null;
}

/** A domain the sender's imitates: one of the company's, or one you've written to or keep contacts at (not one of those itself). */
function lookalikeDomain(user, domain, ours) {
  const domainOf = (e) => String(e || '').toLowerCase().split('@')[1];
  const known = new Set([
    ...q('SELECT email FROM mail_sent_to WHERE owner_id = ? ORDER BY times DESC LIMIT 500').all(user.id).map((r) => domainOf(r.email)),
    ...q('SELECT email FROM contacts WHERE owner_id = ? AND email IS NOT NULL LIMIT 2000').all(user.id).map((r) => domainOf(r.email)),
  ].filter(Boolean));
  if (known.has(domain)) return null; // someone you deal with already
  return lookalikeOf(domain, [...ours.map((d) => ({ domain: d, kind: 'company' })), ...[...known].filter((d) => !ours.includes(d)).map((d) => ({ domain: d, kind: 'known' }))]);
}

export const askOutside = (orgId) => !!q('SELECT ask_outside FROM orgs WHERE id = ?').get(orgId)?.ask_outside;

/** Recipients outside the company: [{ email, new, like? }] (like: { domain, kind } when its domain imitates one you know) (`new`: never written to and not in your contacts), in the order given. */
export function outsideRecipients(user, emails) {
  const ours = new Set(q('SELECT name FROM domains WHERE org_id = ?').all(user.org_id).map((d) => d.name.toLowerCase()));
  const out = [];
  for (const e of new Set((emails || []).map(clean))) {
    const domain = e.split('@')[1];
    if (!domain || !e.includes('@') || ours.has(domain)) continue;
    const known = q('SELECT 1 FROM mail_sent_to WHERE owner_id = ? AND email = ?').get(user.id, e)
      || q(`SELECT 1 FROM contacts WHERE owner_id = ? AND (LOWER(email) = ? OR INSTR(LOWER(COALESCE(more_emails, '')), ?) > 0)`).get(user.id, e, JSON.stringify(e));
    // A new address on a domain made to look like the company's own or one you deal with (acrne.com for acme.com).
    const like = known || [...ours].some((o) => domain.endsWith(`.${o}`)) ? null : lookalikeDomain(user, domain, [...ours]); // (a subdomain of the company's own is real)
    out.push({ email: e, new: !known, ...(like && { like }) });
  }
  return out;
}

export function externalRoutes(r) {
  // ?to=a@x,b@y: everyone on the message so far.
  r.get('/external', (req, res) => {
    const list = String(req.query.to || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const org = q('SELECT name, ask_outside FROM orgs WHERE id = ?').get(req.user.org_id);
    res.json({ company: org?.name || '', ask: !!org?.ask_outside, outside: outsideRecipients(req.user, list) });
  });
}
