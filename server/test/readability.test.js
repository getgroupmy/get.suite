import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readability, countSentences, speakingTime } from '../src/wordcount.js';

test('the server’s copy reads documents the same way: sentences, speaking time, readability', () => {
  assert.equal(countSentences('One. Two! Three?'), 3);
  assert.equal(speakingTime(260), '2 min');
  assert.equal(readability('Short.'), null);
  const easy = 'We met at noon. We had tea. The sun was out. We sat in the park. Kids ran by. A dog barked at a bird. Then it got cold. We went home. ';
  assert.ok(readability(easy).score >= 80);
});
