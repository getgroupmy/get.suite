// Conversations: messages belong together when their subjects match once the "Re:", "Fwd:" (and
// "AW:", "SV:", "[2]"…) in front are taken off, and they share someone (as sender or recipient).

/** A subject without reply/forward prefixes, lower case: "Re: Fwd: Budget" → "budget". */
export function baseSubject(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 10; i++) {
    const next = t.replace(/^\s*(re|fw|fwd|aw|sv|wg|antw|tr|rif|vs)\s*(\[\d+\]|\(\d+\))?\s*:\s*/i, '').replace(/^\s*\[[^\]]{1,40}\]\s*/, (m) => (/^\s*\[\d+\]/.test(m) ? '' : m));
    if (next === t) break;
    t = next;
  }
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Do two messages share a person (sender or recipient)? */
export function shareSomeone(a, b) {
  const people = (m) => new Set([m.from, ...(m.to || []), ...(m.cc || [])].filter(Boolean).map((x) => String(x.address || x).toLowerCase()));
  const pa = people(a);
  return [...people(b)].some((x) => pa.has(x));
}
