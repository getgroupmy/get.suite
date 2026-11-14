// Mail search, as people type it in Gmail: words (all of them, in the subject, sender, recipients
// or text), "exact phrases", -excluded words, and from: to: subject: has:attachment is:unread
// is:read is:starred before: after: older_than: newer_than: larger: smaller:. Turned into an
// IMAP search for the mail server.

const DAY = 864e5;

/** All of these at once. IMAP has no AND for two of the same kind, so those use NOT (OR (NOT a) (NOT b)). */
export function allOf(list) {
  const acc = {}, rest = [];
  for (const c of list) {
    if (Object.keys(c).some((k) => k in acc)) rest.push(c);
    else Object.assign(acc, c);
  }
  const parts = [...(Object.keys(acc).length ? [acc] : []), ...rest];
  if (!parts.length) return {};
  if (parts.length === 1) return parts[0];
  return { not: { or: parts.map((p) => ({ not: p })) } };
}

function day(v) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== +m[3] ? null : d;
}
function size(v) {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(v);
  return m ? Math.round(+m[1] * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()]) : null;
}
function ago(v, now) {
  const m = /^(\d+)([dmy])$/i.exec(v);
  return m ? new Date(now - +m[1] * { d: 1, m: 30, y: 365 }[m[2].toLowerCase()] * DAY) : null;
}

const word = (w) => ({ or: [{ subject: w }, { from: w }, { to: w }, { body: w }] });

/** { query } for imapflow's search, or { error }. An empty search gives { query: null }. */
export function parseMailQuery(text, now = Date.now()) {
  const tokens = String(text || '').match(/-?(?:[a-z_]+:)?(?:"[^"]*"|\S+)/gi) || [];
  const clauses = [];
  for (const raw of tokens) {
    const neg = raw.startsWith('-') && raw.length > 1;
    const t = neg ? raw.slice(1) : raw;
    const m = /^([a-z_]+):(.+)$/i.exec(t);
    const val = (s) => s.replace(/^"(.*)"$/, '$1').trim();
    let c;
    if (m) {
      const op = m[1].toLowerCase(), v = val(m[2]);
      if (!v) continue;
      if (op === 'from') c = { from: v };
      else if (op === 'to') c = { or: [{ to: v }, { cc: v }] };
      else if (op === 'cc') c = { cc: v };
      else if (op === 'subject') c = { subject: v };
      else if (op === 'has' && /^attachments?$/i.test(v)) c = { header: { 'content-type': 'multipart/mixed' } };
      else if (op === 'is' && /^unread$/i.test(v)) c = { seen: false };
      else if (op === 'is' && /^read$/i.test(v)) c = { seen: true };
      else if (op === 'is' && /^(starred|flagged)$/i.test(v)) c = { flagged: true };
      else if (op === 'before' || op === 'after') {
        const d = day(v);
        if (!d) return { error: `Write dates as YYYY-MM-DD (${op}:${v})` };
        c = op === 'before' ? { before: d } : { since: d };
      } else if (op === 'older_than' || op === 'newer_than') {
        const d = ago(v, now);
        if (!d) return { error: `Write ${op} as a number of days, months or years, e.g. ${op}:7d` };
        c = op === 'older_than' ? { before: d } : { since: d };
      } else if (op === 'larger' || op === 'smaller') {
        const n = size(v);
        if (n === null) return { error: `Write sizes like 5M or 200K (${op}:${v})` };
        c = op === 'larger' ? { larger: n } : { smaller: n };
      } else c = word(val(t)); // not an operator we know: search for it as it is
    } else {
      const w = val(t);
      if (!w) continue;
      c = word(w);
    }
    clauses.push(neg ? { not: c } : c);
  }
  return { query: clauses.length ? allOf(clauses) : null };
}

/**
 * A search as the start of a filter (Mail's "Create a filter from this search"): from: to: subject:
 * has:attachment larger: smaller: become their conditions (with - as "doesn't"), and plain words or
 * "phrases" look in the message text. What only makes sense for mail already there (is:unread,
 * before:, newer_than: …) is left out and listed. → { rule, left } or { error }.
 */
export function ruleFromSearch(text) {
  const tokens = String(text || '').match(/-?(?:[a-z_]+:)?(?:"[^"]*"|\S+)/gi) || [];
  const conditions = [], left = [];
  const val = (s) => s.replace(/^"(.*)"$/, '$1').trim();
  const kb = (v) => { const n = size(v); return n === null ? null : n >= 1024 * 1024 ? `${Math.round((n / 1024 / 1024) * 10) / 10} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; };
  for (const raw of tokens) {
    const neg = raw.startsWith('-') && raw.length > 1;
    const t = neg ? raw.slice(1) : raw;
    const m = /^([a-z_]+):(.+)$/i.exec(t);
    const op = neg ? 'not_contains' : 'contains';
    if (!m) { const w = val(t); if (w) conditions.push({ field: 'body', op, value: w }); continue; }
    const key = m[1].toLowerCase(), v = val(m[2]);
    if (!v) continue;
    if (key === 'from' || key === 'subject') conditions.push({ field: key, op, value: v });
    else if (key === 'to' || key === 'cc') conditions.push({ field: 'to', op, value: v });
    else if (key === 'has' && /^attachments?$/i.test(v)) conditions.push({ field: 'attachment', op: neg ? 'has_not' : 'has', value: '' });
    else if ((key === 'larger' || key === 'smaller') && !neg) {
      const s = kb(v);
      if (!s) return { error: `Write sizes like 5M or 200K (${key}:${v})` };
      conditions.push({ field: 'size', op: key === 'larger' ? 'over' : 'under', value: s });
    } else left.push(raw);
  }
  if (!conditions.length) return { error: left.length ? `A filter can't use ${left.join(' ')}: it looks at mail as it arrives` : 'Search for something first' };
  const name = conditions.map((c) => c.value || (c.op === 'has' ? 'with attachments' : 'without attachments')).join(', ').slice(0, 60);
  return { rule: { name, enabled: true, match: 'all', conditions: conditions.slice(0, 10), actions: { stop: true } }, left };
}
