import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookalikeOf, skeleton, editDistance } from '../src/mail/lookalike.js';

const ours = [{ domain: 'acme.com', kind: 'company' }, { domain: 'paypal.com', kind: 'known' }, { domain: 'microsoft.com', kind: 'known' }, { domain: 'globex.co.uk', kind: 'known' }];
const of = (d) => lookalikeOf(d, ours)?.domain || null;

test('reads the same', () => {
  assert.equal(of('paypa1.com'), 'paypal.com');
  assert.equal(of('rnicrosoft.com'), 'microsoft.com');
  assert.equal(of('acrne.com'), 'acme.com');
  assert.equal(of('micros0ft.com'), 'microsoft.com');
  assert.equal(of(`${String.fromCharCode(0x0430)}cme.com`), 'acme.com', 'a Cyrillic a');
  assert.equal(of('xn--cme-5cd.com'), 'acme.com', 'the same, as the mail server writes it (punycode)');
});

test('one letter off, for longer names', () => {
  assert.equal(of('paypall.com'), 'paypal.com');
  assert.equal(of('micorsoft.com'), 'microsoft.com', 'two letters swapped');
  assert.equal(of('globexx.co.uk'), 'globex.co.uk');
  assert.equal(of('acne.com'), null, 'too short a name to tell from chance');
});

test('the company’s own name with another ending or a word added', () => {
  assert.equal(of('acme.co'), 'acme.com');
  assert.equal(of('acme-corp.com'), 'acme.com');
  assert.equal(of('acme-support.net'), 'acme.com');
  assert.equal(of('acmesecure.com'), 'acme.com');
  assert.equal(of('acme-industries-plastics.com'), null, 'not every word');
  assert.equal(of('paypal.co'), null, 'only the company’s own for these');
});

test('not look-alikes', () => {
  for (const d of ['acme.com', 'mail.acme.com', 'example.com', 'google.com', 'apple.com', 'paypal.com', 'shop.paypal.com', 'localhost']) assert.equal(of(d), null, d);
});

test('helpers', () => {
  assert.equal(skeleton('Paypa1.com'), 'paypal.com');
  assert.equal(skeleton('my-shop.com'), 'myshop.com');
  assert.equal(editDistance('acme', 'amce'), 1);
  assert.equal(editDistance('kitten', 'sitting', 5), 3);
});
