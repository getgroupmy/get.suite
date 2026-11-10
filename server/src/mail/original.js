// "Show original": what a message's headers say about where it came from. The checks the receiving
// servers made (SPF, DKIM, DMARC, from Authentication-Results), the servers it passed through and how
// long each step took (Received lines, oldest first), and the Message-ID and when it was written.

/** The header block of a raw message (up to the first empty line), as text, lines unfolded into fields: [[name, value]]. */
export function headerFields(source) {
  const text = Buffer.isBuffer(source) ? source.toString('latin1') : String(source);
  const end = text.search(/\r?\n\r?\n/);
  const block = end < 0 ? text : text.slice(0, end);
  const fields = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1][1] += ` ${line.trim()}`;
    else { const i = line.indexOf(':'); if (i > 0) fields.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
  }
  return { fields, text: block };
}

const RESULT = /\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi;
/** pass / fail / softfail / neutral / none … for each check, from the first Authentication-Results that has it (the nearest server's). */
function checks(fields) {
  const out = {};
  for (const [name, value] of fields) {
    if (!/^(authentication-results|arc-authentication-results)$/i.test(name)) continue;
    for (const m of value.matchAll(RESULT)) { const k = m[1].toLowerCase(); if (!out[k]) out[k] = m[2].toLowerCase(); }
  }
  // Received-SPF (from a server that writes that instead).
  const rs = fields.find(([n]) => /^received-spf$/i.test(n));
  if (!out.spf && rs) out.spf = (/^([a-z]+)/i.exec(rs[1])?.[1] || '').toLowerCase() || undefined;
  return { spf: out.spf || null, dkim: out.dkim || null, dmarc: out.dmarc || null };
}

/** The hops: Received headers oldest first, { from, by, at (ms), delay (ms since the previous hop) }. */
function hops(fields) {
  const list = fields.filter(([n]) => /^received$/i.test(n)).map(([, v]) => {
    const semi = v.lastIndexOf(';');
    const at = semi >= 0 ? Date.parse(v.slice(semi + 1).trim().replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
    return { from: (/\bfrom\s+([^\s;()]+)/i.exec(v) || [])[1] || null, by: (/\bby\s+([^\s;()]+)/i.exec(v) || [])[1] || null, at: Number.isNaN(at) ? null : at };
  }).reverse();
  list.forEach((h, i) => { const prev = list[i - 1]; h.delay = prev?.at != null && h.at != null ? Math.max(0, h.at - prev.at) : null; });
  return list;
}

/** A summary of a raw message's headers for "Show original". */
export function originalSummary(source) {
  const { fields, text } = headerFields(source);
  const get = (n) => fields.find(([k]) => k.toLowerCase() === n)?.[1] ?? null;
  const date = get('date');
  return {
    messageId: get('message-id'), date: date && !Number.isNaN(Date.parse(date)) ? Date.parse(date) : null,
    from: get('from'), to: get('to'), subject: get('subject'),
    ...checks(fields), hops: hops(fields),
    headers: text.length > 200000 ? `${text.slice(0, 200000)}\n…` : text,
  };
}
