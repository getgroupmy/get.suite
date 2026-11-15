// Chat search, typed the way Mail's search is: words (all of them), "exact phrases", -left-out words,
// and from:kim (or from:me), in:#channel (or in:kim for a direct message), has:file has:image has:link,
// is:thread (replies in threads), before:2026-11-01 after:2026-11-01 on:2026-11-01.

const DAY = 864e5;
const HAS = { file: 'file', files: 'file', attachment: 'file', image: 'image', images: 'image', picture: 'image', photo: 'image', link: 'link', links: 'link' };

/** Midnight at the start of YYYY-MM-DD where the person is (tzo: minutes, as Date#getTimezoneOffset gives). */
function day(v, tzo) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== +m[3]) return null;
  return d.getTime() + tzo * 6e4;
}

/**
 * { words, phrases, without, from, in, has, thread, after, before } for a chat search, or { error }.
 * Times are milliseconds: after is the first moment counted, before the first one left out.
 */
export function parseChatQuery(text, { tzo = 0 } = {}) {
  const out = { words: [], phrases: [], without: [], from: [], in: [], has: [], thread: false, after: null, before: null };
  const tokens = String(text || '').match(/-?(?:[a-z]+:)?(?:"[^"]*"?|\S+)/gi) || [];
  const offset = Number.isFinite(+tzo) && Math.abs(+tzo) <= 840 ? +tzo : 0;
  for (const raw of tokens.slice(0, 20)) {
    const neg = raw.startsWith('-') && raw.length > 1;
    const t = neg ? raw.slice(1) : raw;
    const op = /^([a-z]+):(.*)$/i.exec(t);
    const key = op?.[1].toLowerCase();
    const val = op ? op[2].replace(/^"|"$/g, '').trim() : '';
    if (op && !neg && ['from', 'in', 'has', 'is', 'before', 'after', 'on', 'during'].includes(key)) {
      if (!val) return { error: `Add something after ${key}:` };
      if (key === 'from') out.from.push(val.replace(/^@/, '').toLowerCase());
      else if (key === 'in') out.in.push(val.toLowerCase());
      else if (key === 'has') {
        const h = HAS[val.toLowerCase()];
        if (!h) return { error: `has: can be file, image or link` };
        if (!out.has.includes(h)) out.has.push(h);
      } else if (key === 'is') {
        if (!/^(thread|reply|replies)$/i.test(val)) return { error: 'is: can be thread' };
        out.thread = true;
      } else {
        const d = day(val, offset);
        if (d == null) return { error: `Write the date as 2026-11-01 after ${key}:` };
        if (key === 'after') out.after = Math.max(out.after ?? -Infinity, d);
        else if (key === 'before') out.before = Math.min(out.before ?? Infinity, d);
        else { out.after = Math.max(out.after ?? -Infinity, d); out.before = Math.min(out.before ?? Infinity, d + DAY); }
      }
      continue;
    }
    const quoted = /^"(.*?)"?$/.exec(t);
    if (quoted) {
      const p = quoted[1].trim().toLowerCase();
      if (p) (neg ? out.without : out.phrases).push(p);
      continue;
    }
    const ws = t.toLowerCase().match(/[\p{L}\p{N}@._-]+/gu) || [];
    if (neg) out.without.push(...ws); else out.words.push(...ws);
  }
  out.words = out.words.slice(0, 8);
  out.phrases = out.phrases.slice(0, 4);
  out.without = out.without.slice(0, 4);
  if (out.after != null && out.before != null && out.after >= out.before) return { error: 'Nothing can be after that day and before it too' };
  return out;
}

/** Whether there's anything to search for (a filter alone is enough: from:kim lists Kim's messages). */
export const anything = (p) => !!(p.words.length || p.phrases.length || p.from.length || p.in.length || p.has.length || p.thread || p.after != null || p.before != null);
