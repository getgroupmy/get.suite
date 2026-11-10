import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitHtmlQuote, splitTextQuote } from '../src/mail/quotesplit.js';

test('quoted history: Gmail, Apple Mail, Outlook and Workspace replies are split where the quote starts', () => {
  const gmail = '<div dir="ltr">Sounds good, Friday it is.</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Kim wrote:</div><blockquote>Can we meet Friday?</blockquote></div>';
  const g = splitHtmlQuote(gmail);
  assert.equal(g.main, '<div dir="ltr">Sounds good, Friday it is.</div><br>');
  assert.match(g.quoted, /^<div class="gmail_quote">/);
  assert.match(splitHtmlQuote('<p>Yes.</p><blockquote type="cite">Earlier</blockquote>').quoted, /^<blockquote type="cite">/);
  assert.match(splitHtmlQuote('<p>Thanks</p><div id="appendonsend"></div><hr><b>From:</b> Kim').quoted, /^<div id="appendonsend">/);
  const ours = '<p>Agreed.</p><p></p><p>On 10/11/2026, 09:00:00, Kim Park wrote:</p><blockquote><p>Shall we?</p></blockquote>';
  assert.match(splitHtmlQuote(ours).quoted, /^<p>On 10\/11\/2026/);
  // Nothing before it (a forward, or a quote only): nothing folded away.
  assert.equal(splitHtmlQuote('<div class="gmail_quote">only a quote</div>').quoted, null);
  assert.equal(splitHtmlQuote('<p>No quote here at all</p>').quoted, null);
  assert.equal(splitHtmlQuote('').quoted, null);
});

test('quoted history in plain text: "> " lines to the end, with their "On … wrote:" line; Outlook\'s Original Message', () => {
  const t = 'See you then.\n\nOn Mon 9 Nov, Kim Park wrote:\n> Can we meet Friday?\n>\n> Kim\n';
  assert.deepEqual(splitTextQuote(t), { main: 'See you then.', quoted: 'On Mon 9 Nov, Kim Park wrote:\n> Can we meet Friday?\n>\n> Kim\n' });
  const o = splitTextQuote('Done.\r\n\r\n-----Original Message-----\r\nFrom: Kim\r\nSent: Monday\r\n\r\nPlease check.');
  assert.equal(o.main, 'Done.');
  assert.match(o.quoted, /^-----Original Message-----/);
  // A quote in the middle (an inline answer) stays as it is; so does a message that's all quote.
  assert.equal(splitTextQuote('> your question\nmy answer\n> next\nanswer two').quoted, null);
  assert.equal(splitTextQuote('> just a quote').quoted, null);
  assert.equal(splitTextQuote('Plain message').quoted, null);
});
