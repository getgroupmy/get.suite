import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-notify-'));
const { isNewMail } = await import('../src/mail/notify.js');

const T = 1_800_000_000_000;
const msg = (id, { seen = false, ageMin = 0 } = {}) => ({
  flags: new Set(seen ? ['\\Seen'] : []),
  internalDate: new Date(T - ageMin * 60e3),
  envelope: { messageId: id },
});

test('only unread mail delivered in the last few minutes is announced', () => {
  const w = { announced: new Map() };
  assert.equal(isNewMail(w, msg('<a@x>'), T), true);
  assert.equal(isNewMail(w, msg('<b@x>', { seen: true }), T), false, 'already read');
  assert.equal(isNewMail(w, msg('<c@x>', { ageMin: 45 }), T), false, 'moved here, arrived long ago (e.g. archived by hand)');
  assert.equal(isNewMail(w, msg('<d@x>', { ageMin: 3 }), T), true, 'arrived a few minutes ago');
});

test('a message is announced once, even when it moves between followed folders', () => {
  const w = { announced: new Map() };
  assert.equal(isNewMail(w, msg('<e@x>'), T), true); // arrives in the Inbox
  assert.equal(isNewMail(w, msg('<e@x>'), T + 5e3), false); // archived straight away, still unread
  assert.equal(isNewMail(w, { flags: new Set(), internalDate: new Date(T) }, T), true, 'no Message-ID: still announced');
  // Old entries are forgotten, so the list doesn't grow while a tab stays open for days.
  isNewMail(w, msg('<f@x>'), T + 60 * 60e3);
  assert.ok(!w.announced.has('<e@x>'));
});
