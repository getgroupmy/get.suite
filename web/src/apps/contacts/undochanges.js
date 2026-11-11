// Contacts → Undo changes: the times to go back to.
export const UNDO_CHOICES = [
  { key: '10m', label: '10 minutes ago', ms: 10 * 60e3 },
  { key: '1h', label: '1 hour ago', ms: 60 * 60e3 },
  { key: '1d', label: 'Yesterday (24 hours ago)', ms: 24 * 60 * 60e3 },
  { key: '1w', label: '1 week ago', ms: 7 * 24 * 60 * 60e3 },
];
export const UNDO_DAYS = 30;

/** The time a choice means, or for 'custom' the date and time typed (a datetime-local value); null if unusable. */
export function undoTime(key, custom, now = Date.now()) {
  const c = UNDO_CHOICES.find((x) => x.key === key);
  if (c) return now - c.ms;
  if (key !== 'custom' || !custom) return null;
  const t = new Date(custom).getTime();
  if (!Number.isFinite(t) || t >= now || t < now - UNDO_DAYS * 864e5) return null;
  return t;
}

export const changedText = (n) => (n === 0 ? 'No contacts have changed since then.' : `${n} contact${n === 1 ? ' has' : 's have'} changed since then and will go back as ${n === 1 ? 'it was' : 'they were'}.`);
