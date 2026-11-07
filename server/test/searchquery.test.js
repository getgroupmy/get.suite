import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMailQuery, allOf } from '../src/mail/searchquery.js';

const now = Date.UTC(2026, 10, 7);

test('operators and words become one IMAP search', () => {
  assert.deepEqual(parseMailQuery('from:raj is:unread has:attachment invoice', now).query, {
    from: 'raj', seen: false, header: { 'content-type': 'multipart/mixed' },
    or: [{ subject: 'invoice' }, { from: 'invoice' }, { to: 'invoice' }, { body: 'invoice' }],
  });
  assert.deepEqual(parseMailQuery('subject:"quarterly report" -spam', now).query, {
    subject: 'quarterly report', not: { or: [{ subject: 'spam' }, { from: 'spam' }, { to: 'spam' }, { body: 'spam' }] },
  });
  assert.deepEqual(parseMailQuery('after:2026-01-31 before:2026-03-01 larger:5M', now).query,
    { since: new Date(Date.UTC(2026, 0, 31)), before: new Date(Date.UTC(2026, 2, 1)), larger: 5 * 1024 * 1024 });
  assert.deepEqual(parseMailQuery('newer_than:7d', now).query, { since: new Date(now - 7 * 864e5) });
  assert.deepEqual(parseMailQuery('is:starred to:kim', now).query, { flagged: true, or: [{ to: 'kim' }, { cc: 'kim' }] });
  assert.equal(parseMailQuery('   ', now).query, null);
});

test('two of the same kind both have to match', () => {
  const q = parseMailQuery('budget plan', now).query;
  assert.deepEqual(q, { not: { or: [{ not: { or: [{ subject: 'budget' }, { from: 'budget' }, { to: 'budget' }, { body: 'budget' }] } }, { not: { or: [{ subject: 'plan' }, { from: 'plan' }, { to: 'plan' }, { body: 'plan' }] } }] } });
  assert.deepEqual(allOf([{ from: 'a' }, { seen: false }, { from: 'b' }]), { not: { or: [{ not: { from: 'a', seen: false } }, { not: { from: 'b' } }] } });
});

test('mistakes are explained; unknown operators are just words', () => {
  assert.match(parseMailQuery('before:yesterday', now).error, /YYYY-MM-DD/);
  assert.match(parseMailQuery('before:2026-02-30', now).error, /YYYY-MM-DD/);
  assert.match(parseMailQuery('larger:huge', now).error, /5M/);
  assert.deepEqual(parseMailQuery('ref:123', now).query, { or: [{ subject: 'ref:123' }, { from: 'ref:123' }, { to: 'ref:123' }, { body: 'ref:123' }] });
});
