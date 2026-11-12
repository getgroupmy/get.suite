import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forYou, commentLink } from './commentsFilter.js';

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
