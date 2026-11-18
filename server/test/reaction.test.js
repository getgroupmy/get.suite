import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { buildReaction, cleanEmoji, reactionOf, splitReaction } from '../src/mail/reaction.js';

test('one emoji is a reaction; text, two emoji or nothing are not', () => {
  for (const e of ['👍', '❤️', '👍🏽', '👨‍👩‍👧', '🇬🇧', '🎉']) assert.equal(cleanEmoji(` ${e} `), e);
  for (const x of ['', 'ok', '👍👍', 'a👍', ':)', null, '1']) assert.equal(cleanEmoji(x), null, String(x));
});

test('a reaction email (RFC 9078): threaded to the original, the emoji in a reaction part, a sentence for other mail apps', async () => {
  const original = { messageId: '<orig-1@acme.com>', references: ['<root@acme.com>'], subject: 'Q3 numbers' };
  const raw = buildReaction(original, { from: { name: 'Kim Park', address: 'kim@acme.com' }, to: [{ name: 'Olivia Owner', address: 'olivia@acme.com' }], emoji: '🎉', host: 'mail.acme.com' });
  assert.match(raw, /^In-Reply-To: <orig-1@acme\.com>$/m);
  assert.match(raw, /^References: <root@acme\.com> <orig-1@acme\.com>$/m);
  assert.match(raw, /^Subject: Re: Q3 numbers$/m);
  assert.match(raw, /Content-Disposition: reaction\r\n\r\n🎉\r\n/);
  const p = await simpleParser(Buffer.from(raw));
  assert.equal(p.text.trim(), 'Kim Park reacted to your message with 🎉', 'what other mail apps show');
  assert.deepEqual(reactionOf(p), { emoji: '🎉', to: '<orig-1@acme.com>' });
  // Opened in Workspace: the reaction part isn't listed as an attachment.
  assert.deepEqual(splitReaction(p), { emoji: '🎉', to: '<orig-1@acme.com>' });
  assert.equal(p.attachments.length, 0);
  // Already "Re:": not doubled.
  assert.match(buildReaction({ ...original, subject: 'RE: Q3' }, { from: { address: 'k@a.com' }, to: [{ address: 'o@a.com' }], emoji: '👍', host: 'h' }), /^Subject: RE: Q3$/m);
});

test('an ordinary reply, or a reaction part with words in it, is not a reaction', async () => {
  const reply = await simpleParser(Buffer.from('From: a@x.com\r\nIn-Reply-To: <o@x>\r\nSubject: Re: Hi\r\n\r\nThanks!\r\n'));
  assert.equal(reactionOf(reply), null);
  const words = await simpleParser(Buffer.from(['From: a@x.com', 'In-Reply-To: <o@x>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', 'Content-Disposition: reaction', '', 'Click here', '--b--', ''].join('\r\n')));
  assert.equal(reactionOf(words), null);
  const noParent = await simpleParser(Buffer.from(['From: a@x.com', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', 'Content-Disposition: reaction', '', '👍', '--b--', ''].join('\r\n')));
  assert.equal(reactionOf(noParent), null, 'not about any message');
});
