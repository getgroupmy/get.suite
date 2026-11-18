// A message's importance, as mail apps mark it: Outlook's Importance: High, and X-Priority 1 or 2 (Highest,
// High), as Thunderbird and others write it. Low importance (Importance: Low, X-Priority 4 or 5) too.

/** 'high', 'low' or null, from a message's raw headers (as text). */
export function importanceOf(headers) {
  const text = String(headers || '').replace(/\r?\n[ \t]+/g, ' ');
  const imp = /^importance:\s*(\w+)/im.exec(text)?.[1]?.toLowerCase();
  const pri = Number(/^x-priority:\s*(\d)/im.exec(text)?.[1]);
  if (imp === 'high' || pri === 1 || pri === 2) return 'high';
  if (imp === 'low' || pri === 4 || pri === 5) return 'low';
  return null;
}

/** The IMAP search for high-importance mail (is:important). */
export const importantQuery = () => ({ or: [{ header: { importance: 'high' } }, { or: [{ header: { 'x-priority': '1' } }, { header: { 'x-priority': '2' } }] }] });

/** The headers a message sent as high importance carries (as Outlook writes them, and as others read them). */
export const highImportanceHeaders = () => ({ 'X-Priority': '1 (Highest)', 'X-MSMail-Priority': 'High', Importance: 'High' });
