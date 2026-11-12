import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forYou, commentLink, newSince } from './commentsFilter.js';

const me = { id: 'u1', username: 'ann@acme.com' };
const t = (id, extra = {}, replies = []) => ({ id, author_id: 'u2', body: '', replies, ...extra });

test('for you: mentioned in the thread or a reply, or assigned; not your own mention of yourself', () => {
  const threads = [
    t('a', { body: 'Hi @Ann@Acme.com can you check' }),
    t('b', { body: 'nothing here' }, [{ author_id: 'u3', body: 'cc @ann@acme.com' }]),
    t('c', { assignee_id: 'u1' }),
    t('d', { author_id: 'u1', body: 'note to self @ann@acme.com' }),
    t('e', { body: '@annie@acme.com' }),
    t('f', { body: 'mail ann@acme.com directly' }),
  ];
  assert.deepEqual(forYou(threads, me).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(forYou(threads, null), []);
});

test('comment links: the editor page, or the preview in Drive', () => {
  assert.equal(commentLink('https://ws.example', '/docs/f1', 'f1', 'c9'), 'https://ws.example/docs/f1?comment=c9');
  assert.equal(commentLink('https://ws.example', '/drive/folder/x', 'f2', 'c9'), 'https://ws.example/drive?preview=f2&comment=c9');
});

test('new since you last looked: others’ comments or replies written or changed after; never looked means all of theirs', () => {
  const threads = [
    { id: 'old', author_id: 'u2', created_at: 100, replies: [] },
    { id: 'reply', author_id: 'u2', created_at: 100, replies: [{ author_id: 'u3', created_at: 300 }] },
    { id: 'mine', author_id: 'u1', created_at: 300, replies: [{ author_id: 'u1', created_at: 400 }] },
    { id: 'edited', author_id: 'u2', created_at: 100, edited_at: 250, replies: [] },
  ];
  assert.deepEqual(newSince(threads, 200, 'u1').map((t) => t.id), ['reply', 'edited']);
  assert.deepEqual(newSince(threads, null, 'u1').map((t) => t.id), ['old', 'reply', 'edited']);
  assert.deepEqual(newSince(threads, 500, 'u1'), []);
});
