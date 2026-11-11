import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanKeywords, keywordIn } from '../src/chatkeywords.js';

test('keywords are tidied', () => {
  assert.deepEqual(cleanKeywords(' Deploy, invoice ,DEPLOY,, Project  Falcon '), ['deploy', 'invoice', 'project falcon']);
  assert.deepEqual(cleanKeywords(['Café']), ['café']);
  assert.throws(() => cleanKeywords('x'), /too short/);
  assert.throws(() => cleanKeywords('@kim'), /Leave out the @/);
  assert.throws(() => cleanKeywords(Array.from({ length: 21 }, (_, i) => `word${i}`)), /At most 20/);
  assert.throws(() => cleanKeywords('a'.repeat(41)), /too long/);
});

test('found as whole words, in any case', () => {
  assert.equal(keywordIn('Ready to DEPLOY now?', ['deploy']), 'deploy');
  assert.equal(keywordIn('we deployed it', ['deploy']), null);
  assert.equal(keywordIn('the deploy-script', ['deploy']), 'deploy');
  assert.equal(keywordIn('Project  Falcon is late', ['project falcon']), 'project falcon');
  assert.equal(keywordIn('Le café est fermé', ['café']), 'café');
  assert.equal(keywordIn('cafés', ['café']), null);
  assert.equal(keywordIn('costs $5 (approx.)', ['(approx.)']), '(approx.)', 'punctuation is matched as written');
  assert.equal(keywordIn('the abc team', ['a.c']), null, 'not as a pattern');
  assert.equal(keywordIn('', ['x1']), null);
});
