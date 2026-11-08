import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readQueue, requestQueueAction, queueCheck } from '../src/mail/queue.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nw-queue-'));
const now = Date.parse('2026-11-08T12:00:00Z');
const report = (dir, { at = now, done = 0, messages = [] } = {}) => fs.writeFileSync(path.join(dir, 'queue.jsonl'),
  [JSON.stringify({ at: at / 1000, done }), ...messages.map((m) => JSON.stringify(m))].join('\n') + '\n');
const msg = (id, hoursAgo, reason = 'connect to mx.example.net[203.0.113.5]:25: Connection timed out') => ({
  queue_name: 'deferred', queue_id: id, arrival_time: (now - hoursAgo * 3600e3) / 1000, message_size: 2048, sender: 'kim@acme.test',
  recipients: [{ address: 'client@example.net', delay_reason: reason }],
});

test('mail queue: the mail server’s report is read, oldest first', () => {
  const dir = tmp();
  assert.equal(readQueue(dir), null, 'nothing reported yet');
  assert.equal(readQueue(null), null);
  report(dir, { done: 3, messages: [msg('BBB222', 1), msg('AAA111', 5)] });
  const qd = readQueue(dir);
  assert.equal(qd.at, now);
  assert.equal(qd.done, 3);
  assert.deepEqual(qd.messages.map((m) => m.id), ['AAA111', 'BBB222']);
  assert.deepEqual(qd.messages[0].recipients, [{ address: 'client@example.net', reason: msg('x', 0).recipients[0].delay_reason }]);
  assert.equal(qd.messages[0].arrived, now - 5 * 3600e3);
});

test('mail queue: requests are numbered after what was done, and done ones are dropped', () => {
  const configDir = tmp(), statusDir = tmp();
  const file = path.join(configDir, 'queue', 'actions');
  assert.equal(requestQueueAction('retry', 'AAA111', { configDir, statusDir }), 1);
  assert.equal(requestQueueAction('flush', null, { configDir, statusDir }), 2);
  assert.equal(fs.readFileSync(file, 'utf8'), '1 retry AAA111\n2 flush\n');
  report(statusDir, { done: 2 });
  assert.equal(requestQueueAction('delete', 'AAA111', { configDir, statusDir }), 3);
  assert.equal(fs.readFileSync(file, 'utf8'), '3 delete AAA111\n');
  report(statusDir, { done: 7 }); // the actions file was lost, the mail server remembers
  assert.equal(requestQueueAction('flush', null, { configDir, statusDir }), 8);
  assert.throws(() => requestQueueAction('delete', '../../etc', { configDir, statusDir }), /Not a queued message/);
  assert.throws(() => requestQueueAction('delete', 'ALL', { configDir, statusDir }), /Not a queued message/);
  assert.throws(() => requestQueueAction('requeue', 'AAA111', { configDir, statusDir }), /Unknown/);
});

test('mail queue: the health check', () => {
  const dir = tmp();
  report(dir);
  assert.deepEqual(queueCheck(readQueue(dir), now), { status: 'ok', detail: 'Nothing waiting to go out' });
  report(dir, { messages: [msg('AAA111', 0.2)] });
  assert.equal(queueCheck(readQueue(dir), now).status, 'ok', 'a few minutes: retries are normal');
  report(dir, { messages: [msg('AAA111', 3), msg('BBB222', 0.1)] });
  let c = queueCheck(readQueue(dir), now);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /^2 messages waiting; the oldest for 3 hours \(connect to mx\.example\.net/);
  report(dir, { messages: [msg('AAA111', 30)] });
  assert.equal(queueCheck(readQueue(dir), now).status, 'bad');
  report(dir, { at: now - 10 * 60e3 });
  c = queueCheck(readQueue(dir), now);
  assert.deepEqual([c.status, /hasn’t reported/.test(c.detail)], ['warn', true], 'the mail server stopped reporting');
  assert.equal(queueCheck(null, now), null);
});
