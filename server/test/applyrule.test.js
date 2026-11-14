import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionQuery, exactly, matchingUids, applyRule } from '../src/mail/applyrule.js';

test('a filter condition as an IMAP search', () => {
  assert.deepEqual(conditionQuery({ field: 'from', op: 'contains', value: 'acme' }), { query: { from: 'acme' }, exact: false });
  assert.deepEqual(conditionQuery({ field: 'from', op: 'is', value: 'a@acme.com' }), { query: { from: 'a@acme.com' }, exact: true });
  assert.deepEqual(conditionQuery({ field: 'to', op: 'not_contains', value: 'kim' }).query, { not: { or: [{ to: 'kim' }, { cc: 'kim' }] } });
  assert.deepEqual(conditionQuery({ field: 'body', op: 'contains', value: 'invoice' }).query, { body: 'invoice' });
  assert.deepEqual(conditionQuery({ field: 'list', op: 'contains', value: 'news.acme.com' }).query, { header: { 'list-id': 'news.acme.com' } });
  assert.deepEqual(conditionQuery({ field: 'size', op: 'over', value: '5 MB' }).query, { larger: 5 * 1024 * 1024 });
  assert.deepEqual(conditionQuery({ field: 'size', op: 'under', value: '300 KB' }).query, { smaller: 300 * 1024 });
  assert.deepEqual(conditionQuery({ field: 'attachment', op: 'has_not', value: '' }).query, { not: { header: { 'content-type': 'multipart/mixed' } } });
});

test('"is exactly" against the envelope, case aside', () => {
  const env = { subject: ' Weekly Report ', from: [{ address: 'Boss@Acme.com' }], to: [{ address: 'me@acme.com' }], cc: [{ address: 'kim@acme.com' }] };
  assert.ok(exactly({ field: 'subject', value: 'weekly report' }, env));
  assert.ok(!exactly({ field: 'subject', value: 'weekly' }, env));
  assert.ok(exactly({ field: 'from', value: 'boss@acme.com' }, env));
  assert.ok(exactly({ field: 'to', value: 'kim@acme.com' }, env));
  assert.ok(!exactly({ field: 'to', value: 'acme.com' }, env));
});

/** An IMAP client stand-in: searches answered from a table, envelopes from another; records what's done. */
const fake = (answers, envelopes = {}) => {
  const done = [];
  return {
    done,
    async search(q) { return answers[JSON.stringify(q)] || []; },
    async *fetch(set) { for (const uid of set.split(',').map(Number)) yield { uid, envelope: envelopes[uid] }; },
    async messageFlagsAdd(set, flags) { done.push(['flags', set, flags]); },
    async messageFlagsRemove(set, flags) { done.push(['unflag', set, flags]); },
    async mailboxCreate(p) { done.push(['create', p]); },
    async mailboxSubscribe() {},
    async messageMove(set, to) { done.push(['move', set, to]); },
  };
};

test('all of the conditions, or any of them; exact ones checked', async () => {
  const c = fake({ '{"from":"acme"}': [1, 2, 3, 4], '{"subject":"Invoice"}': [2, 4, 9], '{"subject":"report"}': [5, 6] },
    { 5: { subject: 'Report' }, 6: { subject: 'Report for May' } });
  const all = { match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'acme' }, { field: 'subject', op: 'contains', value: 'Invoice' }] };
  assert.deepEqual(await matchingUids(c, all), [2, 4]);
  assert.deepEqual(await matchingUids(c, { ...all, match: 'any' }), [1, 2, 3, 4, 9]);
  assert.deepEqual(await matchingUids(c, { match: 'all', conditions: [{ field: 'subject', op: 'is', value: 'report' }] }), [5]);
});

test('applying: read, star and label, then moved; delete goes to Trash; nothing matched does nothing', async () => {
  const c = fake({ '{"from":"acme"}': [3, 7] });
  const rule = { match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'acme' }], actions: { markRead: true, star: true, moveTo: 'Clients/Acme' } };
  assert.deepEqual(await applyRule(c, rule, { keyword: 'nwl_x' }), { matched: 2, moved: 2 });
  assert.deepEqual(c.done, [['flags', '3,7', ['\\Seen', '\\Flagged', 'nwl_x']], ['create', 'Clients/Acme'], ['move', '3,7', 'Clients/Acme']]);
  const d = fake({ '{"from":"acme"}': [3] });
  assert.deepEqual(await applyRule(d, { ...rule, actions: { delete: true, markRead: true } }, { trash: 'Deleted' }), { matched: 1, moved: 1 });
  assert.deepEqual(d.done, [['move', '3', 'Deleted']]);
  const e = fake({});
  assert.deepEqual(await applyRule(e, rule), { matched: 0, moved: 0 });
  assert.deepEqual(e.done, []);
  // Forwarding alone does nothing to old mail; "move to Inbox" from the Inbox doesn't move.
  const f = fake({ '{"from":"acme"}': [1] });
  assert.deepEqual(await applyRule(f, { ...rule, actions: { forwardTo: 'x@y.com', moveTo: 'INBOX' } }), { matched: 1, moved: 0 });
  assert.deepEqual(f.done, []);
});

test('applying a tab: the other tab\'s mark comes off first', async () => {
  const c = fake({ '{"from":"acme"}': [4] });
  await applyRule(c, { match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'acme' }], actions: { tab: 'primary' } });
  assert.deepEqual(c.done, [['unflag', '4', ['$NwUpdates']], ['flags', '4', ['$NwPrimary']]]);
});
