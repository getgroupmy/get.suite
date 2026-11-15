// Live captions in a meeting: each speaker's latest words, the most recent speakers last (at most three
// shown), each fading after a few seconds of quiet. A caption is { id, name, text, final }: interim text
// replaces the speaker's words still being worked out; final text adds to what they've said.
import { captionText } from '../slides/captions.js';

export const QUIET_MS = 6000;

/** The captions after one arrives (at `at`): [{ id, name, done: [], interim, at }], latest speaker last. */
export function addCaption(list, c, at = Date.now()) {
  const old = list.find((x) => x.id === c.id);
  const done = old && at - old.at < QUIET_MS ? old.done : [];
  const next = { id: c.id, name: c.name, done: c.final ? [...done, c.text].slice(-6) : done, interim: c.final ? '' : c.text, at };
  return [...list.filter((x) => x.id !== c.id), next];
}

/** What to show now: speakers heard in the last few seconds, at most three, each with their latest words. */
export function shownCaptions(list, now = Date.now(), max = 3) {
  return list.filter((x) => now - x.at < QUIET_MS).slice(-max).map((x) => ({ id: x.id, name: x.name, text: captionText(x.done, x.interim, 110) })).filter((x) => x.text);
}
