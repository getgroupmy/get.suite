import { Router } from 'express';
import { audit } from '../audit.js';
import dns from 'node:dns';
import { q } from '../db.js';
import { uid, now, str, bad, notFound, forbidden } from '../util.js';
import { requireAdmin, requireSuper } from '../auth.js';
import { validDomain } from '../tenancy.js';
import { isSharedAddress, membersOf as sharedMembers } from '../mail/shared.js';
import { mailEnabled, MAIL_HOSTNAME, ensureDkim, DKIM_SELECTOR, scheduleMailConfig } from '../mail/config.js';
import { readReports } from '../mail/reports.js';
import { parseMaillog, readMaillog, messagesFor } from '../mail/maillog.js';
import { checkBlocklists } from '../mail/blocklists.js';

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const LOCAL_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

let resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
if (process.env.MAIL_DNS_SERVERS) resolver.setServers(process.env.MAIL_DNS_SERVERS.split(',').map((s) => s.trim()));
/** Tests swap in a fake resolver. */
export function setResolver(r) { resolver = r; }

let lastBlocklists = null; // { at, value }: lookups are kept a while, so the hourly health check doesn't ask every hour
/** The mail host's addresses on the spam blocklists: { host, checked_at, results, note }. Cached for 6 hours unless fresh. */
export async function mailBlocklists({ fresh = false, now = Date.now() } = {}) {
  if (!fresh && lastBlocklists && now - lastBlocklists.at < 6 * 3600e3) return lastBlocklists.value;
  const host = MAIL_HOSTNAME;
  let value;
  if (!host) value = { host: null, results: [], note: 'MAIL_HOSTNAME is not set' };
  else {
    let ips = null;
    try { ips = await resolver.resolve4(host); } catch (e) { value = { host, results: [], note: `No A record for ${host} (${e.code || e.message})` }; }
    if (ips) {
      const results = await checkBlocklists(ips, (name) => resolver.resolve4(name));
      value = { host, checked_at: now, results, ...(!results.length && { note: `${ips.join(', ')} isn’t a public address: blocklists only list public ones` }) };
    }
  }
  lastBlocklists = { at: now, value };
  return value;
}

function targetOrg(req) {
  const id = req.query.org_id || req.body?.org_id;
  if (id && id !== req.user.org_id) {
    if (!req.user.is_super) throw forbidden('You can only manage your own company');
    if (!q('SELECT 1 FROM orgs WHERE id = ?').get(id)) throw notFound('Company not found');
    return id;
  }
  return req.user.org_id;
}

/** Where people open Workspace (PUBLIC_URL's host), for the MTA-STS policy's address. */
const webHost = () => { try { return new URL(process.env.PUBLIC_URL).hostname; } catch { return null; } };

/** A domain's MTA-STS policy (the text senders fetch), or null when it's off. */
export function mtaStsPolicy(domain) {
  const d = q('SELECT mta_sts FROM domains WHERE name = ?').get(domain);
  if (!d || !['testing', 'enforce'].includes(d.mta_sts)) return null;
  return `version: STSv1\r\nmode: ${d.mta_sts}\r\nmx: ${MAIL_HOSTNAME || 'mail.example.com'}\r\nmax_age: ${d.mta_sts === 'enforce' ? 604800 : 86400}\r\n`;
}

/** The DNS records a hosted domain needs. */
export function recordsFor(domain) {
  const host = MAIL_HOSTNAME || 'mail.example.com';
  const { dkim_public } = ensureDkim(domain) || {};
  const sts = q('SELECT mta_sts, mta_sts_id FROM domains WHERE name = ?').get(domain);
  const stsOn = sts && ['testing', 'enforce'].includes(sts.mta_sts);
  return [
    { type: 'MX', host: domain, value: `10 ${host}`, purpose: 'Delivers mail for this domain to your NAS' },
    { type: 'TXT', host: domain, value: 'v=spf1 mx ~all', purpose: 'SPF: says your mail server may send for this domain' },
    { type: 'TXT', host: `${DKIM_SELECTOR}._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${dkim_public}`, purpose: 'DKIM: lets receivers verify your signature' },
    { type: 'TXT', host: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, purpose: 'DMARC: tells receivers what to do with forged mail' },
    // Encrypted delivery (MTA-STS): the policy is a file at mta-sts.<domain>, which this server answers.
    ...(stsOn ? [
      { type: 'CNAME', host: `mta-sts.${domain}`, value: webHost() || '(the address you open Workspace at)', purpose: 'MTA-STS: where senders fetch the policy (this Workspace; add the name to its HTTPS certificate)' },
      { type: 'TXT', host: `_mta-sts.${domain}`, value: `v=STSv1; id=${sts.mta_sts_id}`, purpose: 'MTA-STS: says there is a policy, and when it last changed' },
      { type: 'TXT', host: `_smtp._tls.${domain}`, value: `v=TLSRPTv1; rua=mailto:postmaster@${domain}`, purpose: 'TLS reports: senders tell postmaster@ when they couldn\'t deliver securely' },
      { type: 'HTTPS', host: `https://mta-sts.${domain}/.well-known/mta-sts.txt`, value: `mode: ${sts.mta_sts}`, purpose: 'The policy file itself (checked, not a DNS record)' },
    ] : []),
  ];
}

const txt = async (name) => (await resolver.resolveTxt(name)).map((parts) => parts.join(''));

/** Fetch a policy file over HTTPS (tests swap this out). */
let fetchPolicy = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `HTTP ${res.status}` });
  return res.text();
};
export function setPolicyFetcher(f) { fetchPolicy = f; }

async function checkRecord(rec) {
  try {
    if (rec.type === 'HTTPS') {
      const body = await fetchPolicy(rec.host);
      const mode = /^mode:\s*(\w+)/m.exec(body)?.[1];
      return { found: [body.trim().split(/\r?\n/).join(' · ')], ok: /^version:\s*STSv1/m.test(body) && `mode: ${mode}` === rec.value };
    }
    if (rec.type === 'CNAME') {
      const want = rec.value.toLowerCase();
      const cname = await resolver.resolveCname(rec.host).catch(() => []);
      if (cname.some((c) => c.toLowerCase().replace(/\.$/, '') === want)) return { found: cname, ok: true };
      // An A record to the same address as Workspace will do too.
      const [mine, theirs] = await Promise.all([resolver.resolve4(want).catch(() => []), resolver.resolve4(rec.host).catch(() => [])]);
      return { found: cname.length ? cname : theirs, ok: theirs.length > 0 && theirs.every((a) => mine.includes(a)) };
    }
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
    if (rec.value.startsWith('v=STSv1')) {
      const sts = records.filter((r) => /^v=STSv1/i.test(r));
      return { found: sts, ok: sts.length === 1 && sts[0].replace(/\s/g, '').includes(rec.value.split(' ')[1]), note: sts.length === 1 && !sts[0].includes(rec.value.split(' ')[1]) ? 'Update the id: the policy changed' : undefined };
    }
    if (rec.value.startsWith('v=TLSRPTv1')) {
      const rpt = records.filter((r) => /^v=TLSRPTv1/i.test(r));
      return { found: rpt, ok: rpt.length === 1 };
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
    res.json(q('SELECT name, catchall, mta_sts FROM domains WHERE org_id = ? ORDER BY created_at').all(orgId)
      .map((d) => ({ name: d.name, catchall: d.catchall || null, mta_sts: d.mta_sts || 'off', records: recordsFor(d.name) })));
  });

  // Catch-all: one mailbox of this company receives mail for any unknown address on the domain.
  r.patch('/domains/:name', (req, res) => {
    const orgId = targetOrg(req);
    const name = validDomain(req.params.name);
    if (!q('SELECT 1 FROM domains WHERE name = ? AND org_id = ?').get(name, orgId)) throw notFound('Domain not found');
    // Encrypted delivery (MTA-STS): off, testing (senders report problems but still deliver) or enforce.
    if (req.body.mta_sts !== undefined) {
      const mode = String(req.body.mta_sts);
      if (!['off', 'testing', 'enforce'].includes(mode)) throw bad('Encrypted delivery: off, testing or enforce');
      q('UPDATE domains SET mta_sts = ?, mta_sts_id = ? WHERE name = ?').run(mode, mode === 'off' ? null : String(Date.now()), name);
      audit(req, 'domain.update', { org: orgId, target: name, details: { mta_sts: mode } });
      if (req.body.catchall === undefined) return res.json({ name, mta_sts: mode, records: recordsFor(name) });
    }
    let target = req.body.catchall ? String(req.body.catchall).trim().toLowerCase() : null;
    if (target && !q('SELECT 1 FROM users WHERE username = ? AND org_id = ?').get(target, orgId)) {
      throw bad('The catch-all must be a mailbox in this company');
    }
    q('UPDATE domains SET catchall = ? WHERE name = ?').run(target, name);
    scheduleMailConfig();
    audit(req, 'domain.update', { org: orgId, target: name, details: { catchall: target } });
    res.json({ name, catchall: target });
  });

  // DMARC and TLS reports sent to postmaster@ (which reaches the admins): read from this admin's own
  // mailbox, last 30 days, and shown for the company's domains.
  r.get('/reports', async (req, res) => {
    if (!mailEnabled()) throw bad('This server has no email');
    const orgId = targetOrg(req);
    const mine = new Set(q('SELECT name FROM domains WHERE org_id = ?').all(orgId).map((d) => d.name));
    const got = await readReports(req.user, { days: Math.min(Math.max(Number(req.query.days) || 30, 1), 90) });
    res.json({ ...got, domains: got.domains.filter((d) => mine.has(d.domain)) });
  });

  // The email log: what happened to mail sent from or to the company's domains (Postfix's log, read
  // from the status folder the mail container shares). ?q= an address or Message-ID, ?status=, ?days=.
  r.get('/log', (req, res) => {
    if (!mailEnabled()) throw bad('This server has no email');
    const orgId = targetOrg(req);
    const text = readMaillog();
    if (text === null) return res.json({ available: false, messages: [] });
    const domains = new Set(q('SELECT name FROM domains WHERE org_id = ?').all(orgId).map((d) => d.name));
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
    const status = ['delivered', 'waiting', 'bounced', 'refused'].includes(req.query.status) ? req.query.status : '';
    res.json({ available: true, messages: messagesFor(parseMaillog(text), domains, { q: String(req.query.q || '').slice(0, 200), status, since: Date.now() - days * 864e5 }) });
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

  // Platform owner: is the mail host's address on a spam blocklist? (Spamhaus, SpamCop, Barracuda…)
  r.get('/blocklists', requireSuper, async (req, res) => res.json(await mailBlocklists({ fresh: true })));

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
    if (q('SELECT 1 FROM users WHERE username = ?').get(address) || q('SELECT 1 FROM aliases WHERE address = ?').get(address) || isSharedAddress(address)) throw bad(`${address} is already taken`);
    const targets = parseTargets(req.body.targets);
    if (targets.includes(address)) throw bad('An alias cannot forward to itself');
    const id = uid();
    q('INSERT INTO aliases (id, org_id, address, targets, created_at) VALUES (?, ?, ?, ?, ?)').run(id, orgId, address, targets.join(','), now());
    scheduleMailConfig();
    audit(req, 'alias.create', { org: orgId, target: address, details: { targets } });
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
    audit(req, 'alias.update', { org: a.org_id, target: a.address, details: { targets } });
    res.json({ id: a.id, address: a.address, targets });
  });

  r.delete('/aliases/:id', (req, res) => {
    const a = loadAlias(req);
    q('DELETE FROM aliases WHERE id = ?').run(a.id);
    scheduleMailConfig();
    audit(req, 'alias.delete', { org: a.org_id, target: a.address });
    res.json({ ok: true });
  });

  // ---- shared mailboxes (support@, info@…): their own mailbox, read and answered by the members chosen ----
  const sharedOut = (m) => ({ id: m.id, address: m.address, name: m.name, created_at: m.created_at, members: sharedMembers(m.id), auto_subject: m.auto_subject || null, auto_reply: m.auto_reply || null, signature: m.signature || null });
  /** The signature its people's mail ends with (plain text; {name} is whoever writes). */
  const signatureOf = (b) => { const t = String(b.signature ?? '').replace(/\r\n?/g, '\n').trim(); if (t.length > 2000) throw bad('The signature is too long (2,000 characters at most)'); return t || null; };
  /** The automatic reply from a request: { auto_reply: text | '' (off), auto_subject }. */
  const autoReply = (b) => {
    const text = String(b.auto_reply ?? '').replace(/\r\n?/g, '\n').trim();
    if (text.length > 4000) throw bad('The automatic reply is too long (4,000 characters at most)');
    const subject = str(b.auto_subject ?? '', { max: 200 }) || null;
    return { text: text || null, subject };
  };
  const membersFrom = (orgId, list) => {
    const ids = [...new Set((Array.isArray(list) ? list : []).map(String))];
    if (ids.length > 200) throw bad('At most 200 members');
    for (const id of ids) if (!q('SELECT 1 FROM users WHERE id = ? AND org_id = ?').get(id, orgId)) throw bad('Members must be people in this company');
    return ids;
  };
  const setMembers = (id, ids) => { q('DELETE FROM shared_mailbox_members WHERE mailbox_id = ?').run(id); for (const u of ids) q('INSERT INTO shared_mailbox_members (mailbox_id, user_id) VALUES (?, ?)').run(id, u); };
  r.get('/shared', (req, res) => {
    const orgId = targetOrg(req);
    res.json(q('SELECT * FROM shared_mailboxes WHERE org_id = ? ORDER BY address').all(orgId).map(sharedOut));
  });
  r.post('/shared', (req, res) => {
    const orgId = targetOrg(req);
    const local = str(req.body.local, { required: true, name: 'Address', max: 64 }).toLowerCase();
    if (!LOCAL_RE.test(local) || local.includes('..')) throw bad('The part before @ may contain letters, numbers, dots, dashes, plus and underscores');
    const domain = validDomain(req.body.domain);
    if (!q('SELECT 1 FROM domains WHERE name = ? AND org_id = ?').get(domain, orgId)) throw bad(`${domain} is not a domain of this company`);
    const address = `${local}@${domain}`;
    if (q('SELECT 1 FROM users WHERE username = ?').get(address) || q('SELECT 1 FROM aliases WHERE address = ?').get(address) || isSharedAddress(address)) throw bad(`${address} is already taken`);
    const name = str(req.body.name, { max: 100 }) || local.charAt(0).toUpperCase() + local.slice(1);
    const members = membersFrom(orgId, req.body.members);
    const id = uid();
    q('INSERT INTO shared_mailboxes (id, org_id, address, name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, orgId, address, name, now());
    setMembers(id, members);
    if (req.body.auto_reply !== undefined) { const a = autoReply(req.body); q('UPDATE shared_mailboxes SET auto_reply = ?, auto_subject = ? WHERE id = ?').run(a.text, a.subject, id); }
    if (req.body.signature !== undefined) q('UPDATE shared_mailboxes SET signature = ? WHERE id = ?').run(signatureOf(req.body), id);
    scheduleMailConfig();
    audit(req, 'shared_mailbox.create', { org: orgId, target: address, details: { members: members.length } });
    res.status(201).json(sharedOut(q('SELECT * FROM shared_mailboxes WHERE id = ?').get(id)));
  });
  const loadShared = (req) => {
    const m = q('SELECT * FROM shared_mailboxes WHERE id = ?').get(req.params.id);
    if (!m || (m.org_id !== req.user.org_id && !req.user.is_super)) throw notFound('Shared mailbox not found');
    return m;
  };
  r.patch('/shared/:id', (req, res) => {
    const m = loadShared(req);
    if (req.body.name !== undefined) q('UPDATE shared_mailboxes SET name = ? WHERE id = ?').run(str(req.body.name, { required: true, name: 'Name', max: 100 }), m.id);
    if (req.body.members !== undefined) setMembers(m.id, membersFrom(m.org_id, req.body.members));
    if (req.body.signature !== undefined) q('UPDATE shared_mailboxes SET signature = ? WHERE id = ?').run(signatureOf(req.body), m.id);
    if (req.body.auto_reply !== undefined) { const a = autoReply(req.body); q('UPDATE shared_mailboxes SET auto_reply = ?, auto_subject = ? WHERE id = ?').run(a.text, a.subject, m.id); scheduleMailConfig(); }
    audit(req, 'shared_mailbox.update', { org: m.org_id, target: m.address });
    res.json(sharedOut(q('SELECT * FROM shared_mailboxes WHERE id = ?').get(m.id)));
  });
  r.delete('/shared/:id', (req, res) => {
    const m = loadShared(req);
    q('DELETE FROM shared_mailboxes WHERE id = ?').run(m.id);
    scheduleMailConfig();
    audit(req, 'shared_mailbox.delete', { org: m.org_id, target: m.address });
    res.json({ ok: true });
  });

  return r;
}
