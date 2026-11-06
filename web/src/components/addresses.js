// Address lines: which address is being typed, and putting a chosen one in its place.

/** The address being typed: the text after the last comma or semicolon before the caret. */
export function currentToken(value, caret) {
  const before = value.slice(0, caret);
  const start = Math.max(before.lastIndexOf(','), before.lastIndexOf(';')) + 1;
  const after = value.slice(caret);
  const endRel = after.search(/[,;]/);
  const end = endRel < 0 ? value.length : caret + endRel;
  return { start, end, text: value.slice(start, end).trim() };
}
/** Put a chosen address in place of the one being typed, and a comma after it. */
export function insertAddress(value, token, p) {
  const name = p.name && p.name.toLowerCase() !== p.email ? `${p.name.replace(/[",<>]/g, '')} <${p.email}>` : p.email;
  const head = value.slice(0, token.start).replace(/\s*$/, '');
  const tail = value.slice(token.end).replace(/^[\s,;]*/, '');
  const text = `${head}${head ? ' ' : ''}${name}, ${tail}`;
  return { text, caret: text.length - tail.length };
}

