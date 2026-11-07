import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseSubject, shareSomeone } from '../src/mail/thread.js';

test('base subject: reply and forward prefixes in several languages come off', () => {
  for (const s of ['Budget 2027', 'Re: Budget 2027', 'RE: re: Budget 2027', 'Fwd: Re: Budget  2027', 'AW: Budget 2027', 'Re[2]: Budget 2027', 'SV:Budget 2027']) assert.equal(baseSubject(s), 'budget 2027', s);
  assert.equal(baseSubject('[Team] Budget'), '[team] budget', 'list tags stay');
  assert.equal(baseSubject(''), '');
  assert.equal(baseSubject('Regarding the budget'), 'regarding the budget');
});

test('share someone: by sender or recipient address, any case', () => {
  assert.ok(shareSomeone({ from: { address: 'kim@x.com' }, to: [] }, { from: { address: 'me@y.com' }, to: [{ address: 'KIM@x.com' }] }));
  assert.ok(!shareSomeone({ from: { address: 'a@x.com' }, to: [{ address: 'b@x.com' }] }, { from: { address: 'c@x.com' }, to: [{ address: 'd@x.com' }] }));
});
