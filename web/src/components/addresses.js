// Address lines: which address is being typed, and putting a chosen one in its place.

/** The address being typed: the text after the last comma or semicolon before the caret. */
export function currentToken(value, caret) {
  const start = lastBreak(value, caret) + 1; // (a comma inside a quoted name, "Doe, Jo", isn't between addresses)
  let end = value.length;
  const st = { quoted: false, angle: false, escaped: false };
  for (let i = start; i < caret; i++) scan(st, value[i]);
  for (let i = caret; i < value.length; i++) if (scan(st, value[i]) && value[i] !== '\n') { end = i; break; }
  return { start, end, text: value.slice(start, end).trim() };
}
/** A person as an address line has them: the name in quotes when it has a character that means something in
 * one (a comma or semicolon would split it, (…) is a comment and "Acme: Billing" a group, both of which mail
 * apps drop from the name), with any " or \ in it escaped. */
export function formatAddress(p) {
  const name = String(p.name || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!name || name.toLowerCase() === p.email) return p.email;
  return `${/[()<>[\]:;@\\,"]/.test(name) ? `"${name.replace(/[\\"]/g, '\\$&')}"` : name} <${p.email}>`;
}
/** (A group puts in everyone in it.) */
export function insertAddress(value, token, p) {
  const name = p.members ? p.members.map(formatAddress).join(', ') : formatAddress(p);
  const head = value.slice(0, token.start).replace(/\s*$/, '');
  const tail = value.slice(token.end).replace(/^[\s,;]*/, '');
  const text = `${head}${head ? ' ' : ''}${name}, ${tail}`;
  return { text, caret: text.length - tail.length };
}


/** An address line's parts: split at commas, semicolons and line breaks, but not inside a quoted name ("Doe, Jo",
 * as Outlook writes names) or between < and >. */
export function splitAddresses(text) {
  const out = [];
  let cur = '';
  const st = { quoted: false, angle: false, escaped: false };
  for (const ch of String(text || '')) { if (scan(st, ch)) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out;
}
/** One character of an address line read: true for a comma, semicolon or line break between addresses
 * (not in a quoted name, where \" and \\ are a quote and a backslash, nor between < and >). */
function scan(st, ch) {
  if (st.escaped) { st.escaped = false; return false; }
  if (st.quoted) { if (ch === '\\') st.escaped = true; else if (ch === '"') st.quoted = false; return false; }
  if (ch === '"' && !st.angle) st.quoted = true;
  else if (ch === '<') st.angle = true;
  else if (ch === '>') st.angle = false;
  return !st.angle && /[,;\n]/.test(ch);
}
/** Where a comma or semicolon between addresses is, before `end` (-1 for none). */
const lastBreak = (value, end) => { let at = -1; const st = { quoted: false, angle: false, escaped: false }; for (let i = 0; i < end; i++) if (scan(st, value[i]) && value[i] !== '\n') at = i; return at; };

/** A name as written: "Say \"hi\"" → Say "hi". */
const unquote = (n) => (/^".*"$/s.test(n) ? n.slice(1, -1).replace(/\\(.)/gs, '$1') : n).trim();
/** "Ann <ann@x.org>, ben@y.org" → { list: [{ name, email }], bad: [what isn't an address] }. */
export function parseAddresses(text) {
  const list = [], bad = [];
  for (const part of splitAddresses(text)) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>$/.exec(t) || /^()([^\s<>]+@[^\s<>]+\.[^\s<>]+)$/.exec(t);
    if (m) list.push({ name: unquote(m[1].trim()), email: m[2].toLowerCase() }); else bad.push(t);
  }
  return { list, bad };
}
