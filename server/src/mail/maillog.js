// The email log (Admin → Email → Email log): Postfix's log, which the mail container writes to the
// status folder (maillog, and up to two older maillog.*.gz), read into one entry per message: when,
// from whom, its Message-ID, and for each recipient what happened (delivered, waiting to retry,
// bounced, or refused at the door) with the receiving server's answer.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const LINE = /^(?:(\w{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)|(\d{4}-\d\d-\d\dT\S+))\s+\S+\s+postfix\/[\w/-]+\[\d+\]:\s+(.*)$/;

/** A log line's time: "Nov 10 02:26:41" (this year, or last year if that would be in the future) or ISO. */
function timeOf(m, now) {
  if (m[6]) return Date.parse(m[6]) || null;
  const d = new Date(now);
  let t = new Date(d.getFullYear(), MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime();
  if (t > now + 864e5) t = new Date(d.getFullYear() - 1, MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]).getTime();
  return t;
}
const addr = (s) => String(s || '').trim().toLowerCase();
const STATUS = { sent: 'delivered', deferred: 'waiting', bounced: 'bounced', expired: 'bounced' };

/** Log text → messages, newest first: [{ id, at, from, messageId, size, client, recipients: [{ to, origTo, status, response, relay, at, tries }] }]. */
export function parseMaillog(text, now = Date.now()) {
  const byId = new Map();
  const out = [];
  const msg = (id, at) => {
    let m = byId.get(id);
    if (!m) { m = { id, at, from: null, messageId: null, size: null, client: null, recipients: [] }; byId.set(id, m); out.push(m); }
    return m;
  };
  for (const line of String(text).split('\n')) {
    const m = LINE.exec(line);
    if (!m) continue;
    const at = timeOf(m, now), rest = m[7];
    // Refused while being handed over (unknown address, spam, blocked): no queue id.
    const nq = /^NOQUEUE: reject: RCPT from (\S+): (\d{3} [\d.]+ .*?); from=<([^>]*)> to=<([^>]*)>/.exec(rest);
    if (nq) {
      out.push({ id: null, at, from: addr(nq[3]) || null, messageId: null, size: null, client: nq[1], recipients: [{ to: addr(nq[4]), origTo: null, status: 'refused', response: nq[2], relay: null, at, tries: 1 }] });
      continue;
    }
    const q = /^([0-9A-F]{6,}|[0-9A-Za-z]{12,}): (.*)$/.exec(rest);
    if (!q) continue;
    const [, id, what] = q;
    let x;
    if ((x = /^client=(\S+)/.exec(what))) msg(id, at).client = x[1];
    else if ((x = /^message-id=<?([^>\s]*)>?/.exec(what))) msg(id, at).messageId = x[1] || null;
    else if ((x = /^from=<([^>]*)>, size=(\d+)/.exec(what))) { const e = msg(id, at); e.from = addr(x[1]) || null; e.size = Number(x[2]); }
    else if ((x = /^to=<([^>]*)>,(?: orig_to=<([^>]*)>,)? relay=([^,]+),.*? status=(\w+) \((.*)\)$/.exec(what))) {
      const e = msg(id, at);
      const to = addr(x[1]), origTo = x[2] ? addr(x[2]) : null;
      let r = e.recipients.find((y) => y.to === to && y.origTo === origTo);
      if (!r) { r = { to, origTo, status: null, response: null, relay: null, at, tries: 0 }; e.recipients.push(r); }
      Object.assign(r, { status: STATUS[x[4]] || x[4], response: x[5], relay: x[3] === 'none' ? null : x[3], at, tries: r.tries + 1 });
    }
  }
  return out.filter((e) => e.recipients.length || e.from).sort((a, b) => b.at - a.at);
}

/** The log files, oldest first: up to two rotated ones (maillog.<date>.gz) and the current maillog. */
export function readMaillog(dir = process.env.MAIL_STATUS_DIR || '/var/nw-status', maxBytes = 30 * 1024 * 1024) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  if (!names.includes('maillog')) return null;
  const old = names.filter((n) => /^maillog\..+\.gz$/.test(n)).sort().slice(-2);
  let text = '';
  for (const n of old) { try { text += zlib.gunzipSync(fs.readFileSync(path.join(dir, n)), { maxOutputLength: maxBytes }).toString('utf8'); } catch { /* skip a broken one */ } }
  const cur = path.join(dir, 'maillog');
  const size = fs.statSync(cur).size;
  const fd = fs.openSync(cur, 'r');
  try {
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text += buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}

/**
 * The messages a company may see: sent from or to one of its domains (a recipient after aliases
 * counts too). `q` matches an address or Message-ID; `status` one recipient's outcome.
 */
export function messagesFor(messages, domains, { q = '', status = '', since = 0, limit = 200 } = {}) {
  const ours = (a) => !!a && domains.has(String(a).split('@')[1]);
  const term = String(q || '').trim().toLowerCase();
  const res = [];
  for (const m of messages) {
    if (m.at < since) continue;
    if (!(ours(m.from) || m.recipients.some((r) => ours(r.to) || ours(r.origTo)))) continue;
    if (term && !(m.from?.includes(term) || m.messageId?.toLowerCase().includes(term) || m.recipients.some((r) => r.to.includes(term) || r.origTo?.includes(term)))) continue;
    if (status && !m.recipients.some((r) => r.status === status)) continue;
    res.push(m);
    if (res.length >= limit) break;
  }
  return res;
}
