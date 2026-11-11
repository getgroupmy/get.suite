import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-tidy-')); // a database of its own
const { tidyQuery, TIDY_DAYS } = await import('../src/mail/tidy.js');
const { tabQuery } = await import('../src/mail/tabs.js');

test('tidying looks for Updates mail before the cut-off, not starred', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const qy = tidyQuery(30, now);
  const flat = JSON.stringify(qy);
  assert.deepEqual(qy.or, tabQuery('updates').or, 'the Updates tab');
  assert.match(flat, /"before":"2026-10-12T12:00:00.000Z"/);
  assert.match(flat, /"flagged":false/);
  assert.deepEqual(TIDY_DAYS, [7, 14, 30, 60, 90]);
});
