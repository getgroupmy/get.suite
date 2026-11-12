import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-vacooo-db-'));
const { midnightIn } = await import('../src/mail/vacation.js');

test('midnight at the start of a day in a time zone, across the clocks changing', () => {
  assert.equal(midnightIn('2031-07-07', 'Europe/Berlin'), Date.parse('2031-07-06T22:00:00Z'), 'summer time');
  assert.equal(midnightIn('2031-01-07', 'Europe/Berlin'), Date.parse('2031-01-06T23:00:00Z'), 'winter time');
  assert.equal(midnightIn('2031-03-30', 'Europe/Berlin'), Date.parse('2031-03-29T23:00:00Z'), 'the day the clocks go forward');
  assert.equal(midnightIn('2031-07-07', 'America/New_York'), Date.parse('2031-07-07T04:00:00Z'));
  assert.equal(midnightIn('2031-07-07', 'UTC'), Date.parse('2031-07-07T00:00:00Z'));
  assert.equal(midnightIn('2031-07-07', 'Not/AZone'), Date.parse('2031-07-07T00:00:00Z'), 'unknown zone: UTC');
});
