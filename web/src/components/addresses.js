// Address lines: which address is being typed, and putting a chosen one in its place.

/** The address being typed: the text after the last comma or semicolon before the caret. */
export function currentToken(value, caret) {
  const start = lastBreak(value, caret) + 1; // (a comma inside a quoted name, "Doe, Jo", isn't between addresses)
  let end = value.length;
  for (let i = caret, quoted = (value.slice(start, caret).match(/"/g) || []).length % 2 === 1; i < value.length; i++) { if (value[i] === '"') quoted = !quoted; else if (!quoted && (value[i] === ',' || value[i] === ';')) { end = i; break; } }
  return { start, end, text: value.slice(start, end).trim() };
}
/** Put a chosen address in place of the one being typed, and a comma after it. */
export const formatAddress = (p) => (p.name && p.name.toLowerCase() !== p.email ? `${p.name.replace(/[",<>]/g, '')} <${p.email}>` : p.email);
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
  let cur = '', quoted = false, angle = false;
  for (const ch of String(text || '')) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (!quoted && !angle && /[,;\n]/.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
/** Where a comma or semicolon outside quotes is, at or before `i` (-1 for none). */
const lastBreak = (value, end) => { let at = -1, quoted = false; for (let i = 0; i < end; i++) { if (value[i] === '"') quoted = !quoted; else if (!quoted && (value[i] === ',' || value[i] === ';')) at = i; } return at; };

/** "Ann <ann@x.org>, ben@y.org" → { list: [{ name, email }], bad: [what isn't an address] }. */
export function parseAddresses(text) {
  const list = [], bad = [];
  for (const part of splitAddresses(text)) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+\.[^<>\s]+)>$/.exec(t) || /^()([^\s<>]+@[^\s<>]+\.[^\s<>]+)$/.exec(t);
    if (m) list.push({ name: m[1].replace(/^"|"$/g, '').trim(), email: m[2].toLowerCase() }); else bad.push(t);
  }
  return { list, bad };
}
