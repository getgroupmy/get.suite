// Pure helpers for Meet.

/** A meeting code from whatever was typed or pasted: "abc-defg-hij", "ABC DEFG HIJ", "abcdefghij" or a link. */
export function parseCode(input) {
  const s = String(input || '').trim().toLowerCase();
  const fromLink = s.match(/\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/);
  if (fromLink) return fromLink[1];
  const letters = s.replace(/[\s-]+/g, '');
  return /^[a-z]{10}$/.test(letters) ? `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}` : null;
}

/** Columns for a grid of n tiles: 1, 2, 2, 2, 3, 3, 3, 3 (up to 8 people). */
export const columnsFor = (n) => (n <= 1 ? 1 : n <= 4 ? 2 : 3);

/** "Mia is here", "Mia and Max are here", "Mia, Max and 2 others are here". */
export function whoIsHere(names) {
  if (!names.length) return 'No one else is here yet';
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length === 3 ? 'other' : 'others'} are here`;
}

/** "0:05", "12:34", "1:02:03" since the call started. */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Who fills the big space: the person you pinned (while they're still here), else someone presenting
 * their screen (yours aside: you know what you share), else nobody (everyone in a grid). With one
 * person there's no one to spotlight.
 */
export function spotlightOf(tiles, pinned) {
  if (tiles.length < 2) return null;
  if (pinned && tiles.some((t) => t.id === pinned)) return pinned;
  return tiles.find((t) => !t.me && t.state?.screen)?.id || null;
}
