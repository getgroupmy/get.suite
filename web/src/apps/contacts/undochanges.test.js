import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoTime, changedText } from './undochanges.js';

const now = Date.UTC(2026, 10, 11, 12, 0);

test('the time each choice means', () => {
  assert.equal(undoTime('10m', '', now), now - 600000);
  assert.equal(undoTime('1w', '', now), now - 7 * 864e5);
});

test('a time of your own: in the past, within 30 days', () => {
  const d = new Date(now - 2 * 864e5);
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(undoTime('custom', local, now), d.getTime());
  assert.equal(undoTime('custom', '', now), null);
  assert.equal(undoTime('custom', '2020-01-01T00:00', now), null, 'too long ago');
  assert.equal(undoTime('custom', '2030-01-01T00:00', now), null, 'the future');
  assert.equal(undoTime('nope', '', now), null);
});

test('what it will do', () => {
  assert.equal(changedText(0), 'No contacts have changed since then.');
  assert.equal(changedText(1), '1 contact has changed since then and will go back as it was.');
  assert.equal(changedText(3), '3 contacts have changed since then and will go back as they were.');
});
