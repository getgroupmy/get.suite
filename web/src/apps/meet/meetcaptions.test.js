import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCaption, shownCaptions, QUIET_MS } from './meetcaptions.js';

test("a speaker's words: interim replaced, finished ones added", () => {
  let l = addCaption([], { id: 'a', name: 'Kim', text: 'good', final: false }, 1000);
  l = addCaption(l, { id: 'a', name: 'Kim', text: 'good morning', final: true }, 1500);
  l = addCaption(l, { id: 'a', name: 'Kim', text: 'every', final: false }, 2000);
  assert.deepEqual(shownCaptions(l, 2100), [{ id: 'a', name: 'Kim', text: 'good morning every' }]);
});

test('the latest speaker last, at most three; quiet ones fade', () => {
  let l = [];
  for (const [id, t] of [['a', 0], ['b', 100], ['c', 200], ['d', 300]]) l = addCaption(l, { id, name: id.toUpperCase(), text: `hi from ${id}`, final: true }, t);
  assert.deepEqual(shownCaptions(l, 400).map((x) => x.name), ['B', 'C', 'D']);
  l = addCaption(l, { id: 'b', name: 'B', text: 'again', final: true }, 500);
  assert.deepEqual(shownCaptions(l, 600).map((x) => x.name), ['C', 'D', 'B']);
  assert.deepEqual(shownCaptions(l, 500 + QUIET_MS + 1), [], 'all quiet');
});

test('speaking again after a pause starts afresh', () => {
  let l = addCaption([], { id: 'a', name: 'Kim', text: 'first point', final: true }, 0);
  l = addCaption(l, { id: 'a', name: 'Kim', text: 'second point', final: true }, QUIET_MS + 10);
  assert.equal(shownCaptions(l, QUIET_MS + 20)[0].text, 'second point');
});

test('transcript lines: a speaker still talking joins their line; someone else starts a new one', async () => {
  const { addTranscriptLine, transcriptDoc } = await import('./meetcaptions.js');
  let l = addTranscriptLine([], { name: 'Kim', text: 'good morning' }, 0);
  l = addTranscriptLine(l, { name: 'Kim', text: 'shall we start' }, 5000);
  l = addTranscriptLine(l, { name: 'Max', text: 'yes' }, 6000);
  l = addTranscriptLine(l, { name: 'Max', text: '  ' }, 6500);
  l = addTranscriptLine(l, { name: 'Max', text: 'later point' }, 6000 + 31000);
  assert.deepEqual(l.map((x) => [x.name, x.text]), [['Kim', 'good morning shall we start'], ['Max', 'yes'], ['Max', 'later point']]);
  const doc = transcriptDoc('Standup', l, 0);
  assert.equal(doc.content[0].content[0].text, 'Standup: transcript');
  assert.equal(doc.content.length, 2 + 3);
  assert.deepEqual(doc.content[2].content.slice(1).map((x) => x.text), ['Kim:', ' good morning shall we start']);
  assert.match(JSON.stringify(transcriptDoc('X', [], 0)), /Nothing was said/);
});
