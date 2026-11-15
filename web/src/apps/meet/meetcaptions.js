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

// ---- Keeping a transcript: the finished captions, with who and when, saved to Drive as a document. ----

/** Add a finished phrase: joined to the speaker's last line when they're still talking (within 30 s). */
export function addTranscriptLine(lines, { name, text }, at = Date.now()) {
  const t = String(text || '').trim();
  if (!t) return lines;
  const last = lines[lines.length - 1];
  if (last && last.name === name && at - last.until < 30000) return [...lines.slice(0, -1), { ...last, text: `${last.text} ${t}`, until: at }];
  return [...lines, { name, text: t, at, until: at }];
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** The transcript as a document (TipTap JSON): a heading, when, then "10:02 Kim Park: …" per line. */
export function transcriptDoc(title, lines, startedAt) {
  const p = (content) => ({ type: 'paragraph', content });
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: `${title}: transcript` }] },
      p([{ type: 'text', text: `${new Date(startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Made from live captions, so words may have been misheard.`, marks: [{ type: 'italic' }] }]),
      ...(lines.length ? lines.map((l) => p([{ type: 'text', text: `${hhmm(l.at)} ` }, { type: 'text', text: `${l.name}:`, marks: [{ type: 'bold' }] }, { type: 'text', text: ` ${l.text}` }]))
        : [p([{ type: 'text', text: 'Nothing was said with captions on.' }])]),
    ],
  };
}
