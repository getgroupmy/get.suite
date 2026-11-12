import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionsAttachment, ownText } from './attachcheck.js';

test('finds the usual ways of saying a file is attached', () => {
  for (const s of ['I have attached the report.', 'See attachment', 'Attachments: two invoices', 'Please find attached our quote',
    'I attach the minutes', 'Enclosed is the contract', 'PFA the deck', 'Please find the invoice below', 'Voir la pièce jointe']) {
    assert.ok(mentionsAttachment({ html: `<p>${s}</p>` }), s);
  }
  assert.equal(mentionsAttachment({ html: '<p>I&#39;ve <strong>attached</strong> it</p>' }), 'attached');
});

test('does not mistake other uses, or what is quoted from earlier mail', () => {
  for (const s of ['Lunch at noon?', 'I am very attached to this plan', 'The cat is detached', 'Reattaching the shelf']) {
    assert.equal(mentionsAttachment({ html: `<p>${s}</p>` }), null, s);
  }
  const reply = '<p>Thanks, got it.</p><p></p><p>On 3/11/2026, 10:00:00, Kim &lt;kim@acme.com&gt; wrote:</p><blockquote><p>I have attached the report.</p></blockquote>';
  assert.equal(mentionsAttachment({ html: reply }), null, 'the quoted message had the file');
  assert.equal(ownText(reply).trim(), 'Thanks, got it.');
  assert.equal(mentionsAttachment({ text: 'Thanks\n> attached is the file' }), null, 'quoted plain text');
});

test('the subject counts too, but not a reply or forward of someone else’s', () => {
  assert.equal(mentionsAttachment({ html: '<p>Hi</p>', subject: 'Invoice attached' }), 'attached');
  assert.equal(mentionsAttachment({ html: '', text: 'here you go', subject: 'Re: Attachments' }), null);
  assert.equal(mentionsAttachment({ html: '', text: 'see attachment', subject: 'Fwd: hi' }), 'attachment');
  assert.equal(mentionsAttachment({ html: '<p>Hi</p>', subject: 'Re: lunch' }), null);
});
