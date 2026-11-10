import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchBlocks, bodyHtml, draftMessage } from './emaildraftmsg.js';

test('email drafts: offered for @email or @draft (two letters on)', () => {
  assert.deepEqual(matchBlocks('em'), [{ kind: 'block', id: 'block:email', label: 'Email draft' }]);
  assert.equal(matchBlocks('draft').length, 1);
  assert.equal(matchBlocks('e').length, 0);
  assert.equal(matchBlocks('kim').length, 0);
});

test('email drafts: the message for Mail, with full links and fields on one line', () => {
  const html = '<p>See <a data-filechip="f1" class="doc-filechip" href="/sheets/f1">📊 Budget</a> and <a href="https://x.example/a">this</a>.</p>';
  assert.equal(bodyHtml(html, 'https://work.acme.com'), '<p>See <a data-filechip="f1" href="https://work.acme.com/sheets/f1">📊 Budget</a> and <a href="https://x.example/a">this</a>.</p>');
  assert.deepEqual(draftMessage({ to: ' kim@acme.com,\nbo@acme.com ', cc: '', subject: 'Q3\r\nfigures' }, '', 'https://w'), { to: 'kim@acme.com, bo@acme.com', cc: '', subject: 'Q3 figures', html: '<p></p>' });
});
