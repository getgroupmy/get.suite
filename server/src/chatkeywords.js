// Keyword alerts in Chat: words or short phrases someone wants to hear about (a project's name, "deploy",
// "invoice"). A channel message containing one tells them as a mention would.
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD = 40;

/** Clean a list typed by someone: trimmed, lower case, no repeats, 2–40 characters, at most 20. */
export function cleanKeywords(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(',');
  const out = [];
  for (const w of raw) {
    const k = String(w ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!k) continue;
    if (k.length < 2) throw new Error(`“${k}” is too short: at least 2 letters`);
    if (k.length > MAX_KEYWORD) throw new Error(`“${k.slice(0, 20)}…” is too long: at most ${MAX_KEYWORD} characters`);
    if (k.startsWith('@')) throw new Error('Leave out the @: mentions of you already tell you');
    if (!out.includes(k)) out.push(k);
  }
  if (out.length > MAX_KEYWORDS) throw new Error(`At most ${MAX_KEYWORDS} keywords`);
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The first of these keywords in the text as a whole word (any case), or null. "deploy" isn't in "deployed". */
export function keywordIn(text, words) {
  const t = String(text || '');
  for (const w of words || []) {
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${esc(w).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'iu').test(t)) return w;
  }
  return null;
}
