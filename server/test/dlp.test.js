import { test } from 'node:test';
import assert from 'node:assert/strict';
const { luhn, ibanOk, findIn, cleanRule, textOfHtml } = await import('../src/dlp.js');

test('check digits: card numbers (Luhn) and IBANs (mod 97)', () => {
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111111111111112'), false);
  assert.equal(ibanOk('GB82 WEST 1234 5698 7654 32'), true);
  assert.equal(ibanOk('GB82 WEST 1234 5698 7654 33'), false);
  assert.equal(ibanOk('DE89370400440532013000'), true);
});

test('detectors find what they should, masked, and leave ordinary numbers alone', () => {
  const card = { detector: 'card' };
  assert.deepEqual(findIn(card, 'Pay with 4111 1111 1111 1111 please'), ['…1111']);
  assert.deepEqual(findIn(card, 'Card: 5500-0000-0000-0004.'), ['…0004']);
  assert.deepEqual(findIn(card, 'Order 1234567890123456 and phone +60 12 345 6789'), [], 'no valid check digit');
  assert.deepEqual(findIn(card, 'Invoice 2026-11-10-0001'), []);
  const iban = { detector: 'iban' };
  assert.deepEqual(findIn(iban, 'Account GB82 WEST 1234 5698 7654 32 at Westminster'), ['…5432']);
  assert.deepEqual(findIn(iban, 'Ref GB00 ABCD 1234 5678 9012 34'), []);
  const words = { detector: 'words', words: ['Project Falcon', 'payroll'] };
  assert.deepEqual(findIn(words, 'Notes on project falcon and the PAYROLL run'), ['Project Falcon', 'payroll']);
  assert.deepEqual(findIn(words, 'payrolling is not a word here'), [], 'whole words only');
  assert.deepEqual(findIn(words, textOfHtml('<p>About <b>Project</b>\n Falcon</p>')), ['Project Falcon'], 'split by tags and lines');
  const pat = { detector: 'pattern', pattern: '\\b\\d{6}-\\d{2}-\\d{4}\\b' };
  assert.deepEqual(findIn(pat, 'IC 900101-14-5678 attached'), ['…5678']);
  assert.equal(textOfHtml('<p>Card&nbsp;<b>4111</b> 1111 1111 1111</p>').replace(/\s+/g, ' ').trim(), 'Card 4111 1111 1111 1111');
});

test('rules are checked: names, detectors, words, safe patterns', () => {
  assert.throws(() => cleanRule({ detector: 'card' }), /name/);
  assert.throws(() => cleanRule({ name: 'x', detector: 'mood' }), /look for/);
  assert.throws(() => cleanRule({ name: 'x', detector: 'words', words: ' , ' }), /at least one/);
  assert.throws(() => cleanRule({ name: 'x', detector: 'pattern', pattern: '(' }), /valid/);
  assert.throws(() => cleanRule({ name: 'x', detector: 'pattern', pattern: '(a+)+$' }), /too slow/);
  assert.throws(() => cleanRule({ name: 'x', detector: 'pattern', pattern: 'a*' }), /matches nothing/);
  const r = cleanRule({ name: ' Secrets ', detector: 'words', words: 'Falcon, falcon,Orion\nOrion', action: 'block', scope: 'all' });
  assert.deepEqual({ ...r, words: JSON.parse(r.words) }, { name: 'Secrets', detector: 'words', words: ['Falcon', 'falcon', 'Orion'], pattern: null, action: 'block', scope: 'all', enabled: 1 });
  assert.equal(cleanRule({ name: 'c', detector: 'card', action: 'nonsense', scope: 'x' }).action, 'warn');
});
