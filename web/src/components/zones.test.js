import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockLine, offsetMinutes } from './zones.js';

test('world clock lines: the time there, whether it is tomorrow or yesterday, and the difference', () => {
  const t = Date.UTC(2026, 10, 10, 20, 0); // 20:00 UTC on 10 Nov
  assert.equal(offsetMinutes('Asia/Kolkata', t), 330);
  assert.equal(offsetMinutes('America/New_York', t), -300);
  const tokyo = clockLine('Asia/Tokyo', t, 'Europe/London');
  assert.deepEqual([tokyo.city, tokyo.day, tokyo.diff], ['Tokyo', 'tomorrow', '+9 h']);
  assert.match(tokyo.time, /5:00/);
  const ny = clockLine('America/New_York', t, 'Europe/London');
  assert.deepEqual([ny.day, ny.diff], ['', '−5 h']);
  assert.deepEqual([clockLine('Asia/Kolkata', t, 'UTC').diff, clockLine('Asia/Kolkata', t, 'UTC').day], ['+5:30 h', 'tomorrow']);
  assert.equal(clockLine('Europe/London', t, 'UTC').diff, 'same time');
  assert.equal(clockLine('Pacific/Honolulu', Date.UTC(2026, 10, 10, 5), 'UTC').day, 'yesterday');
});
