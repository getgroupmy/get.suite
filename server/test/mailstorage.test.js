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
