import { Router } from 'express';
import dns from 'node:dns';
import { q } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { requireAdmin, requireSuper } from '../auth.js';
import { validDomain } from '../tenancy.js';
import { mailEnabled, MAIL_HOSTNAME, ensureDkim, DKIM_SELECTOR, scheduleMailConfig } from '../mail/config.js';

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

let resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
if (process.env.MAIL_DNS_SERVERS) resolver.setServers(process.env.MAIL_DNS_SERVERS.split(',').map((s) => s.trim()));
/** Tests swap in a fake resolver. */
export function setResolver(r) { resolver = r; }

function targetOrg(req) {
  const id = req.query.org_id || req.body?.org_id;
  if (id && id !== req.user.org_id) {
    if (!req.user.is_super) throw forbidden('You can only manage your own company');
    if (!q('SELECT 1 FROM orgs WHERE id = ?').get(id)) throw notFound('Company not found');
    return id;
  }
  return req.user.org_id;
}

/** The DNS records a hosted domain needs. */
export function recordsFor(domain) {
  const host = MAIL_HOSTNAME || 'mail.example.com';
  const { dkim_public } = ensureDkim(domain) || {};
  return [
    { type: 'MX', host: domain, value: `10 ${host}`, purpose: 'Delivers mail for this domain to your NAS' },
    { type: 'TXT', host: domain, value: 'v=spf1 mx ~all', purpose: 'SPF: says your mail server may send for this domain' },
    { type: 'TXT', host: `${DKIM_SELECTOR}._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${dkim_public}`, purpose: 'DKIM: lets receivers verify your signature' },
    { type: 'TXT', host: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, purpose: 'DMARC: tells receivers what to do with forged mail' },
  ];
}

const txt = async (name) => (await resolver.resolveTxt(name)).map((parts) => parts.join(''));

async function checkRecord(rec) {
  try {
    if (rec.type === 'MX') {
      const mx = await resolver.resolveMx(rec.host);
      const found = mx.map((m) => `${m.priority} ${m.exchange}`);
      const want = rec.value.split(' ')[1].toLowerCase();
      return { found, ok: mx.some((m) => m.exchange.toLowerCase().replace(/\.$/, '') === want) };
    }
    const records = await txt(rec.host);
    if (rec.value.startsWith('v=spf1')) {
      const spf = records.filter((r) => r.toLowerCase().startsWith('v=spf1'));
      return { found: spf, ok: spf.length === 1 && /\s(mx|a:|ip4:|include:)/i.test(spf[0]), note: spf.length > 1 ? 'Only one SPF record is allowed' : undefined };
    }
    if (rec.value.startsWith('v=DKIM1')) {
      const key = rec.value.split('p=')[1];
      const dkim = records.filter((r) => r.includes('p='));
      return { found: dkim.map((r) => (r.length > 80 ? `${r.slice(0, 77)}…` : r)), ok: dkim.some((r) => r.replace(/\s/g, '').includes(`p=${key}`)) };
    }
    const dmarc = records.filter((r) => r.toUpperCase().startsWith('V=DMARC1'));
    return { found: dmarc, ok: dmarc.length === 1 };
  } catch (e) {
    return { found: [], ok: false, note: e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? 'Not found' : `DNS lookup failed (${e.code || e.message})` };
  }
}

function parseTargets(list) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/[,\s]+/)).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (!arr.length) throw bad('Add at least one recipient');
  if (arr.length > 50) throw bad('At most 50 recipients');
  for (const t of arr) if (!EMAIL_RE.test(t)) throw bad(`“${t}” is not a valid email address`);
  return [...new Set(arr)];
}

export default function mailAdminRoutes() {
  const r = Router();
  r.use(requireAdmin);

  r.get('/status', (req, res) => res.json({ enabled: mailEnabled(), hostname: MAIL_HOSTNAME }));

  r.get('/domains', (req, res) => {
    const orgId = targetOrg(req);
    res.json(q('SELECT name FROM domains WHERE org_id = ? ORDER BY created_at').all(orgId).map((d) => ({ name: d.name, records: recordsFor(d.name) })));
  });

  r.get('/domains/:name/check', async (req, res) => {
    const orgId = targetOrg(req);
    const name = validDomain(req.params.name);
    if (!q('SELECT 1 FROM domains WHERE name = ? AND org_id = ?').get(name, orgId)) throw notFound('Domain not found');
    const records = recordsFor(name);
    const results = await Promise.all(records.map(async (rec) => ({ ...rec, ...(await checkRecord(rec)) })));
    res.json({ domain: name, ok: results.every((x) => x.ok), results });
  });

  // Platform owner: is the mail host itself reachable and does reverse DNS match?
  r.get('/host-check', requireSuper, async (req, res) => {
    const host = MAIL_HOSTNAME;
    if (!host) return res.json({ ok: false, note: 'MAIL_HOSTNAME is not set' });
    try {
      const ips = await resolver.resolve4(host);
      const ptr = await Promise.all(ips.map((ip) => resolver.reverse(ip).catch(() => [])));
      const ptrOk = ptr.every((names) => names.some((n) => n.toLowerCase().replace(/\.$/, '') === host.toLowerCase()));
      res.json({ host, ips, ptr: ptr.flat(), ok: ptrOk, note: ptrOk ? undefined : `Ask your ISP to set reverse DNS (PTR) of ${ips.join(', ')} to ${host}` });
    } catch (e) {
      res.json({ host, ips: [], ptr: [], ok: false, note: `No A record for ${host} (${e.code || e.message})` });
    }
  });

  // ---- aliases (shared addresses / distribution lists / forwards) ----
  r.get('/aliases', (req, res) => {
    const orgId = targetOrg(req);
    res.json(q('SELECT id, address, targets, created_at FROM aliases WHERE org_id = ? ORDER BY address').all(orgId)
      .map((a) => ({ ...a, targets: a.targets.split(',') })));
  });

  r.post('/aliases', (req, res) => {
    const orgId = targetOrg(req);
    const local = str(req.body.local, { required: true, name: 'Address', max: 64 }).toLowerCase();
    if (!LOCAL_RE.test(local) || local.includes('..')) throw bad('The part before @ may contain letters, numbers, dots, dashes, plus and underscores');
    const domain = validDomain(req.body.domain);
    if (!q('SELECT 1 FROM domains WHERE name = ? AND org_id = ?').get(domain, orgId)) throw bad(`${domain} is not a domain of this company`);
    const address = `${local}@${domain}`;
    if (q('SELECT 1 FROM users WHERE username = ?').get(address) || q('SELECT 1 FROM aliases WHERE address = ?').get(address)) throw bad(`${address} is already taken`);
    const targets = parseTargets(req.body.targets);
    if (targets.includes(address)) throw bad('An alias cannot forward to itself');
    const id = uid();
    q('INSERT INTO aliases (id, org_id, address, targets, created_at) VALUES (?, ?, ?, ?, ?)').run(id, orgId, address, targets.join(','), now());
    scheduleMailConfig();
    res.status(201).json({ id, address, targets });
  });

  const loadAlias = (req) => {
    const a = q('SELECT * FROM aliases WHERE id = ?').get(req.params.id);
    if (!a || (a.org_id !== req.user.org_id && !req.user.is_super)) throw notFound('Alias not found');
    return a;
  };

  r.patch('/aliases/:id', (req, res) => {
    const a = loadAlias(req);
    const targets = parseTargets(req.body.targets);
    if (targets.includes(a.address)) throw bad('An alias cannot forward to itself');
    q('UPDATE aliases SET targets = ? WHERE id = ?').run(targets.join(','), a.id);
    scheduleMailConfig();
    res.json({ id: a.id, address: a.address, targets });
  });

  r.delete('/aliases/:id', (req, res) => {
    const a = loadAlias(req);
    q('DELETE FROM aliases WHERE id = ?').run(a.id);
    scheduleMailConfig();
    res.json({ ok: true });
  });

  return r;
}
