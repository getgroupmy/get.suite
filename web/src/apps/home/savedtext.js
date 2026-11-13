// Home's Saved in Chat card.

/** A saved chat message in a line: its first line of text, or what it carries. */
export function savedText(x) {
  const line = String(x.body || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const plain = line.replace(/[*_~`]+/g, '').replace(/^>\s*/, '');
  if (plain) return plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
  return x.files ? `📎 ${x.files} file${x.files === 1 ? '' : 's'}` : x.email_subject ? `✉ ${x.email_subject}` : 'a message';
}
