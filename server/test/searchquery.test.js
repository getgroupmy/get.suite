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

test('a search as the start of a filter', async () => {
  const { ruleFromSearch } = await import('../src/mail/searchquery.js');
  const { normalizeRules } = await import('../src/mail/sieve.js');
  const { rule, left } = ruleFromSearch('from:billing@acme.com subject:"Your invoice" -to:kim has:attachment larger:2M smaller:500k "pay now" -spam is:unread newer_than:7d');
  assert.deepEqual(rule.conditions, [
    { field: 'from', op: 'contains', value: 'billing@acme.com' },
    { field: 'subject', op: 'contains', value: 'Your invoice' },
    { field: 'to', op: 'not_contains', value: 'kim' },
    { field: 'attachment', op: 'has', value: '' },
    { field: 'size', op: 'over', value: '2 MB' },
    { field: 'size', op: 'under', value: '500 KB' },
    { field: 'body', op: 'contains', value: 'pay now' },
    { field: 'body', op: 'not_contains', value: 'spam' },
  ]);
  assert.deepEqual(left, ['is:unread', 'newer_than:7d']);
  assert.equal(rule.match, 'all');
  assert.match(rule.name, /^billing@acme\.com, Your invoice/);
  // What it gives is a filter as Filters keeps them (only an action is still to choose).
  assert.equal(normalizeRules([{ ...rule, actions: { star: true } }])[0].conditions.length, 8);
  assert.deepEqual(ruleFromSearch('-has:attachment').rule.conditions, [{ field: 'attachment', op: 'has_not', value: '' }]);
  assert.match(ruleFromSearch('is:unread before:2026-01-01').error, /can't use is:unread before:2026-01-01/);
  assert.match(ruleFromSearch('').error, /Search for something first/);
  assert.match(ruleFromSearch('larger:huge').error, /Write sizes like/);
});
