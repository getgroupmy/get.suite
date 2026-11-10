// DMARC and TLS reports: big mail providers (Google, Microsoft, Yahoo…) send postmaster@ a daily
// report for each domain. DMARC aggregate reports (zipped XML) say which servers sent mail as the
// domain and whether it passed SPF and DKIM; TLS reports (gzipped JSON, RFC 8460) say whether mail
// to the domain came in encrypted. postmaster@ reaches the company's admins, so an admin's own
// mailbox holds them: this reads them from there and adds them up. Nothing is stored.
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { parseDocument, DomUtils } from 'htmlparser2';
import { simpleParser } from 'mailparser';
import { ownConnection } from './imap.js';

const MAX_FILE = 20 * 1024 * 1024;

/** A report attachment's text: .gz and .zip unpacked (the first XML or JSON file in a zip). */
export async function unpack(name, data) {
  const n = String(name || '').toLowerCase();
  if (data.length > MAX_FILE) return null;
  try {
    if (n.endsWith('.gz') || n.endsWith('.gzip') || (data[0] === 0x1f && data[1] === 0x8b)) {
      const out = zlib.gunzipSync(data, { maxOutputLength: MAX_FILE });
      return out.toString('utf8');
    }
    if (n.endsWith('.zip') || (data[0] === 0x50 && data[1] === 0x4b)) {
      const zip = await JSZip.loadAsync(data);
      const f = Object.values(zip.files).find((x) => !x.dir && /\.(xml|json)$/i.test(x.name));
      return f ? await f.async('string') : null;
    }
    if (/\.(xml|json)$/.test(n)) return data.toString('utf8');
  } catch { /* not a report we can read */ }
  return null;
}

/** A DMARC aggregate report (XML): who reported, for which domain and days, and each source's results. */
export function parseDmarc(xml) {
  const doc = parseDocument(xml, { xmlMode: true });
  const one = (name, within = doc.children) => DomUtils.findOne((e) => e.name === name, Array.isArray(within) ? within : [within], true);
  const text = (name, within) => { const el = one(name, within); return el ? DomUtils.textContent(el).trim() : ''; };
  if (!one('feedback')) return null;
  const meta = one('report_metadata'), range = one('date_range'), policy = one('policy_published');
  const records = DomUtils.getElementsByTagName('record', doc.children, true).map((r) => ({
    ip: text('source_ip', r),
    count: Number(text('count', r)) || 0,
    disposition: text('disposition', r) || 'none',
    dkim: text('dkim', one('policy_evaluated', r)) || 'fail',
    spf: text('spf', one('policy_evaluated', r)) || 'fail',
    from: text('header_from', r).toLowerCase(),
  }));
  return {
    kind: 'dmarc',
    org: text('org_name', meta) || 'Unknown',
    id: text('report_id', meta),
    begin: (Number(text('begin', range)) || 0) * 1000,
    end: (Number(text('end', range)) || 0) * 1000,
    domain: (text('domain', policy) || records[0]?.from || '').toLowerCase(),
    policy: text('p', policy) || 'none',
    records,
  };
}

/** A TLS report (RFC 8460 JSON): who reported, and for each policy how many sessions worked or failed, and why. */
export function parseTlsrpt(json) {
  let r;
  try { r = JSON.parse(json); } catch { return null; }
  if (!r || !Array.isArray(r.policies)) return null;
  return {
    kind: 'tls',
    org: String(r['organization-name'] || 'Unknown'),
    id: String(r['report-id'] || ''),
    begin: Date.parse(r['date-range']?.['start-datetime']) || 0,
    end: Date.parse(r['date-range']?.['end-datetime']) || 0,
    policies: r.policies.map((p) => ({
      domain: String(p.policy?.['policy-domain'] || '').toLowerCase(),
      type: String(p.policy?.['policy-type'] || ''),
      success: Number(p.summary?.['total-successful-session-count']) || 0,
      failure: Number(p.summary?.['total-failure-session-count']) || 0,
      failures: (p['failure-details'] || []).map((f) => ({ result: String(f['result-type'] || 'unknown'), count: Number(f['failed-session-count']) || 0, mx: String(f['receiving-mx-hostname'] || '') })),
    })),
  };
}

/**
 * Add reports up, per domain: DMARC by sending server (how much passed, failed, and what receivers did
 * with it) and TLS by reporter (sessions that worked and failed, and the reasons).
 */
export function summarize(reports) {
  const seen = new Set();
  const domains = new Map();
  const of = (d) => { if (!domains.has(d)) domains.set(d, { domain: d, dmarc: { messages: 0, pass: 0, fail: 0, sources: new Map(), reporters: new Set(), policy: null }, tls: { success: 0, failure: 0, reasons: new Map(), reporters: new Set() }, from: Infinity, to: 0 }); return domains.get(d); };
  for (const r of reports) {
    if (!r) continue;
    const key = `${r.kind}:${r.org}:${r.id}`;
    if (r.id && seen.has(key)) continue; // the same report sent twice
    seen.add(key);
    if (r.kind === 'dmarc') {
      const d = of(r.domain);
      d.from = Math.min(d.from, r.begin); d.to = Math.max(d.to, r.end);
      d.dmarc.reporters.add(r.org); d.dmarc.policy = r.policy;
      for (const x of r.records) {
        const pass = x.dkim === 'pass' || x.spf === 'pass'; // DMARC passes when either aligned check passes
        d.dmarc.messages += x.count; d.dmarc[pass ? 'pass' : 'fail'] += x.count;
        const s = d.dmarc.sources.get(x.ip) || { ip: x.ip, messages: 0, pass: 0, fail: 0, dkim: 0, spf: 0, quarantined: 0, rejected: 0, reporters: new Set() };
        s.messages += x.count; s[pass ? 'pass' : 'fail'] += x.count;
        if (x.dkim === 'pass') s.dkim += x.count;
        if (x.spf === 'pass') s.spf += x.count;
        if (x.disposition === 'quarantine') s.quarantined += x.count;
        if (x.disposition === 'reject') s.rejected += x.count;
        s.reporters.add(r.org);
        d.dmarc.sources.set(x.ip, s);
      }
    } else if (r.kind === 'tls') {
      for (const p of r.policies) {
        const d = of(p.domain);
        d.from = Math.min(d.from, r.begin); d.to = Math.max(d.to, r.end);
        d.tls.reporters.add(r.org);
        d.tls.success += p.success; d.tls.failure += p.failure;
        for (const f of p.failures) d.tls.reasons.set(f.result, (d.tls.reasons.get(f.result) || 0) + f.count);
      }
    }
  }
  return [...domains.values()].filter((d) => d.domain).map((d) => ({
    domain: d.domain, from: Number.isFinite(d.from) ? d.from : null, to: d.to || null,
    dmarc: { messages: d.dmarc.messages, pass: d.dmarc.pass, fail: d.dmarc.fail, policy: d.dmarc.policy, reporters: [...d.dmarc.reporters].sort(),
      sources: [...d.dmarc.sources.values()].map((s) => ({ ...s, reporters: [...s.reporters].sort() })).sort((a, b) => b.messages - a.messages).slice(0, 50) },
    tls: { success: d.tls.success, failure: d.tls.failure, reporters: [...d.tls.reporters].sort(), reasons: [...d.tls.reasons].map(([result, count]) => ({ result, count })).sort((a, b) => b.count - a.count) },
  })).sort((a, b) => a.domain.localeCompare(b.domain));
}

/** A report in an attachment, or null. */
async function reportIn(att) {
  const text = await unpack(att.filename, att.content);
  if (!text) return null;
  return /^\s*[{[]/.test(text) ? parseTlsrpt(text) : parseDmarc(text);
}

/**
 * Read the reports in someone's mailbox (Inbox and Archive) from the last `days` days: messages
 * with a report attached, at most 400. Gives { reports: n, messages: n, domains: summarize(…) }.
 */
export async function readReports(user, { days = 30, max = 400 } = {}) {
  const client = await ownConnection(user);
  const reports = [];
  let looked = 0;
  try {
    const boxes = (await client.list()).filter((b) => b.path === 'INBOX' || b.specialUse === '\\Archive').map((b) => b.path);
    const since = new Date(Date.now() - days * 864e5);
    for (const box of boxes) {
      const lock = await client.getMailboxLock(box, { readOnly: true });
      try {
        const uids = (await client.search({ since }, { uid: true })) || [];
        // Which ones carry a report: a gz, zip, xml or json attachment.
        const candidates = [];
        if (uids.length) {
          for await (const m of client.fetch(uids.slice(-2000), { uid: true, bodyStructure: true }, { uid: true })) {
            const names = [];
            const walk = (n) => { if (!n) return; const fn = n.dispositionParameters?.filename || n.parameters?.name; if (fn) names.push(fn); (n.childNodes || []).forEach(walk); };
            walk(m.bodyStructure);
            if (names.some((fn) => /\.(xml|xml\.gz|zip|json|json\.gz|gz)$/i.test(fn))) candidates.push(m.uid);
          }
        }
        for (const uid of candidates.slice(-max)) {
          if (looked >= max) break;
          looked++;
          const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!m?.source || m.source.length > MAX_FILE) continue;
          const parsed = await simpleParser(m.source);
          for (const att of parsed.attachments || []) { const rep = await reportIn(att); if (rep) reports.push(rep); }
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
  return { reports: reports.length, messages: looked, domains: summarize(reports) };
}
