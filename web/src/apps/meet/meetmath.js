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
export function spotlightOf(tiles, pinned, hostSpot = null) {
  if (tiles.length < 2) return null;
  if (pinned && tiles.some((t) => t.id === pinned)) return pinned; // your own pin wins
  if (hostSpot && tiles.some((t) => t.id === hostSpot)) return hostSpot; // then the host's spotlight
  return tiles.find((t) => !t.me && t.state?.screen)?.id || null;
}

/** How loud a slice of sound is (0–1), from an analyser's byte samples (128 = silence). */
export function loudness(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (const v of samples) { const x = (v - 128) / 128; sum += x * x; }
  return Math.sqrt(sum / samples.length);
}

/**
 * Who counts as speaking: loud enough now, or within the last `hold` ms (so the ring doesn't
 * flicker between words). `heard` is { id: last time they were loud }; returns the ids speaking.
 */
export function speakingNow(heard, at, hold = 700) {
  return new Set(Object.entries(heard).filter(([, t]) => at - t <= hold).map(([id]) => id));
}
export const SPEAKING_LEVEL = 0.04;

/** The host's countdown, seen from now: { left: 'm:ss', up: time's up, soon: under 30 seconds left }. */
export function countdown(timer, now = Date.now()) {
  if (!timer) return null;
  const ms = Math.max(0, timer.ends_at - now);
  const s = Math.ceil(ms / 1000);
  return { left: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, up: ms === 0, soon: ms > 0 && ms <= 30000 };
}
export const TIMER_CHOICES = [[60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [600, '10 minutes'], [900, '15 minutes'], [1800, '30 minutes']];

/** Who's in a video meeting now, in words: "Kim Park is in it", "Kim and Lee are in it", "Kim and 2 others are in it". */
export function liveText(names = []) {
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is in it now`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are in it now`;
  return `${names[0]} and ${names.length - 1} others are in it now`;
}
