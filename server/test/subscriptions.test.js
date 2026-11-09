import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSubscriptions, headerLinesOf } from '../src/mail/subscriptions.js';

test('header text becomes the lines unsubscribing reads (folded lines joined)', () => {
  assert.deepEqual(headerLinesOf('List-Unsubscribe: <https://n.example/u>,\r\n <mailto:u@n.example>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\n').map((h) => h.key),
    ['list-unsubscribe', 'list-unsubscribe-post']);
});

test('lists grouped by sender, most frequent first, the newest message used to leave', () => {
  const oneClick = 'List-Unsubscribe: <https://news.example/u?x=1>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n';
  const list = groupSubscriptions([
    { uid: 1, from: { address: 'News@News.example', name: 'News' }, date: '2026-11-01T10:00:00Z', headers: oneClick },
    { uid: 5, from: { address: 'news@news.example', name: 'News Weekly' }, date: '2026-11-08T10:00:00Z', headers: oneClick },
    { uid: 3, from: { address: 'deals@shop.example', name: 'Shop' }, date: '2026-11-05T10:00:00Z', headers: 'List-Unsubscribe: <mailto:leave@shop.example>\r\n' },
    { uid: 4, from: { address: 'blog@site.example' }, date: '2026-11-06T10:00:00Z', headers: 'List-Unsubscribe: <http://site.example/leave>\r\n' },
    { uid: 6, from: { address: 'person@x.example' }, date: '2026-11-06T10:00:00Z', headers: 'Subject: hi\r\n' },
  ]);
  assert.deepEqual(list.map((g) => [g.address, g.count, g.uid, g.how]), [
    ['news@news.example', 2, 5, 'one-click'], ['blog@site.example', 1, 4, 'web'], ['deals@shop.example', 1, 3, 'email'],
  ]);
  assert.equal(list[0].name, 'News Weekly');
  assert.deepEqual(list[0].uids, [1, 5]);
  assert.equal(list[1].url, 'http://site.example/leave');
});
