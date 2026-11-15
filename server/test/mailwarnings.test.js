import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailWarnings } from '../src/mail/warnings.js';

test('the warnings as sentences, most serious first', () => {
  const w = mailWarnings({
    from: { address: 'billing@lnitech.com' },
    outside: { external: true, company: 'Acme', address: 'billing@lnitech.com', domain_like: { domain: 'initech.com', kind: 'known' } },
    payment_risk: 'bank',
    reply_elsewhere: { from: 'billing@lnitech.com', reply_to: 'pay@freemail.example' },
    link_warnings: [{ real: 'acme-login.com', like: 'acme.com' }, { shown: 'www.bank.com', real: 'evil.example' }],
    attachments: [{ filename: 'invoice.pdf.exe', risk: { level: 'danger', reasons: ["It's a program (.exe) pretending to be a .pdf file"] } }, { filename: 'ok.pdf' }],
    first_contact: true,
  });
  assert.deepEqual(w, [
    "It comes from lnitech.com, which looks like initech.com but isn't.",
    'It says bank or payment details have changed: confirm by phone, on a number already known, before paying.',
    'Replies to it go to pay@freemail.example, not to the sender (billing@lnitech.com).',
    'A link goes to acme-login.com, made to look like acme.com.',
    'A link says www.bank.com but goes to evil.example.',
    "Attachments that may be harmful: invoice.pdf.exe (It's a program (.exe) pretending to be a .pdf file).",
    "It's the first email from billing@lnitech.com.",
  ]);
});

test('a colleague’s name from outside, a forged sender; and nothing to say about ordinary mail', () => {
  assert.match(mailWarnings({ outside: { lookalike: 'Kim Park', company: 'Acme', address: 'kim.park@freemail.example' } })[0], /may be someone pretending to be them/);
  assert.match(mailWarnings({ from: { address: 'x@paypal.com' }, sender_check: 'forged' })[0], /failed paypal\.com's own DMARC check/);
  assert.deepEqual(mailWarnings({ from: { address: 'kim@acme.com' }, outside: null, link_warnings: [], attachments: [] }), []);
  assert.deepEqual(mailWarnings(null), []);
});
