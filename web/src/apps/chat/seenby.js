// "Seen by …" under your latest message in a small private channel.

/** The readers who have seen a message sent at `at`, first to read first; and the line to show (null for nobody). */
export function seenBy(readers, at, everyone) {
  const who = readers.filter((x) => x.read_at != null && x.read_at >= at).sort((a, b) => a.read_at - b.read_at);
  if (!who.length) return { who, text: null };
  const names = who.map((x) => x.name);
  if (everyone > 1 && who.length >= everyone) return { who, text: 'Seen by everyone' };
  const list = names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
    : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return { who, text: `Seen by ${list}` };
}
