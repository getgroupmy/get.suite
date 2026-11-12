// "Outside the company" in Compose: which of a message's recipients aren't on one of the company's own
// domains, and which of those you've never written to (or kept as a contact), so a message going
// somewhere new is noticed before it leaves.
import { q } from '../db.js';

const clean = (e) => String(e || '').trim().toLowerCase();

/** Recipients outside the company: [{ email, new }] (`new`: never written to and not in your contacts), in the order given. */
export function outsideRecipients(user, emails) {
  const ours = new Set(q('SELECT name FROM domains WHERE org_id = ?').all(user.org_id).map((d) => d.name.toLowerCase()));
  const out = [];
  for (const e of new Set((emails || []).map(clean))) {
    const domain = e.split('@')[1];
    if (!domain || !e.includes('@') || ours.has(domain)) continue;
    const known = q('SELECT 1 FROM mail_sent_to WHERE owner_id = ? AND email = ?').get(user.id, e)
      || q(`SELECT 1 FROM contacts WHERE owner_id = ? AND (LOWER(email) = ? OR INSTR(LOWER(COALESCE(more_emails, '')), ?) > 0)`).get(user.id, e, JSON.stringify(e));
    out.push({ email: e, new: !known });
  }
  return out;
}

export function externalRoutes(r) {
  // ?to=a@x,b@y: everyone on the message so far.
  r.get('/external', (req, res) => {
    const list = String(req.query.to || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const org = q('SELECT name FROM orgs WHERE id = ?').get(req.user.org_id);
    res.json({ company: org?.name || '', outside: outsideRecipients(req.user, list) });
  });
}
