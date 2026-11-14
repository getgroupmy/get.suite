import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warningText } from './phishingtext.js';

test('the warning for everyone: sender and first subject, within 300 characters', () => {
  assert.equal(warningText({ sender: 'payroll@evilpay.com', subjects: ['Confirm your bank details'] }),
    '⚠ Phishing: emails from payroll@evilpay.com (“Confirm your bank details”) are a scam. Don\'t click their links, open their attachments or reply: use Report phishing in Mail.');
  assert.match(warningText({ sender: 'a@b.com', subjects: [] }), /^⚠ Phishing: emails from a@b\.com are a scam/);
  const long = warningText({ sender: `${'x'.repeat(64)}@${'d'.repeat(30)}.com`, subjects: ['y'.repeat(200)] }); // as long as an address gets
  assert.ok(long.length <= 300);
  assert.match(long, /use Report phishing in Mail\.$/, 'the advice stays: the subject goes first');
  assert.doesNotMatch(long, /yyy/);
});
