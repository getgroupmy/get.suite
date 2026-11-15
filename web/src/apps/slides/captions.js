// Live captions while presenting: what the presenter says, along the bottom of the slide. The browser's
// speech recognition hears it (as for voice typing); this keeps the last couple of lines of it.

/**
 * The caption to show: the most recent words heard (finished phrases, then the one still being worked
 * out), at most `max` characters, cut at a word so it reads from the start of one.
 */
export function captionText(finals, interim = '', max = 140) {
  const all = [...finals, interim].join(' ').replace(/\s+/g, ' ').trim();
  if (all.length <= max) return all;
  const tail = all.slice(-max);
  const space = tail.indexOf(' ');
  return space > 0 && space < 30 ? tail.slice(space + 1) : tail;
}

/** The finished phrases worth keeping (the rest scrolled away long ago). */
export const keepRecent = (finals, n = 6) => finals.slice(-n);
