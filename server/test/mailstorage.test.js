import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-mailstorage-')); // a database of its own
const { largestOf, usage } = await import('../src/mail/storage.js');

test('mail storage: the largest first, and use against the limit', () => {
  assert.deepEqual(largestOf([{ size: 5 }, { size: 50 }, { size: 20 }], 2).map((m) => m.size), [50, 20]);
  assert.deepEqual(usage(512 * 1024 * 1024, 1024), { used: 512 * 1024 * 1024, limit: 1024 * 1024 * 1024, percent: 50 });
  assert.deepEqual(usage(2000, null), { used: 2000, limit: null, percent: null }, 'no limit');
  assert.equal(usage(3 * 1024 * 1024, 2).percent, 100, 'over the limit shows as full');
});

test('mailbox nearly full: tell at 90%, again at 100%, once each; forget below 90%', async () => {
  const { fullLevel } = await import('../src/mail/storage.js');
  assert.deepEqual(fullLevel(50, null), { tell: null, told: null });
  assert.deepEqual(fullLevel(91, null), { tell: 90, told: 90 });
  assert.deepEqual(fullLevel(95, 90), { tell: null, told: 90 }, 'already told');
  assert.deepEqual(fullLevel(100, 90), { tell: 100, told: 100 });
  assert.deepEqual(fullLevel(100, 100), { tell: null, told: 100 });
  assert.deepEqual(fullLevel(92, 100), { tell: null, told: 100 }, 'not again on the way down');
  assert.deepEqual(fullLevel(40, 100), { tell: null, told: null }, 'room again: tell next time');
});
