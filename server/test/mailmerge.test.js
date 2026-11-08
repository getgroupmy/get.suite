import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fillTemplate, mergeHtml, placeholders, unknownPlaceholders } from '../src/mail/merge.js';

test("the web app's copy of mail merge matches the server's", () => {
  const read = (u) => fs.readFileSync(new URL(u, import.meta.url), 'utf8');
  assert.equal(read('../../web/src/apps/sheets/mailmerge.js'), read('../src/mail/merge.js'));
});

test('mail merge: placeholders filled from the row', () => {
  const fields = { 'First name': 'Ana', Company: 'Acme & Co', Amount: 120 };
  assert.equal(fillTemplate('Hi {{First name}}, {{ company }} owes {{AMOUNT}}.', fields), 'Hi Ana, Acme & Co owes 120.');
  assert.equal(fillTemplate('{{Nope}} stays', fields), '{{Nope}} stays');
  assert.deepEqual(placeholders('{{A}} {{ b }} {{A}}'), ['A', 'b']);
  assert.deepEqual(unknownPlaceholders('Hi {{First name}}', 'From {{Team}}', ['first name', 'Email']), ['Team']);
  assert.equal(mergeHtml('Dear {{Company}},\nthanks.\n\nBye <3', fields), '<p>Dear Acme &amp; Co,<br>thanks.</p>\n<p>Bye &lt;3</p>');
  assert.equal(mergeHtml('{{Company}}', { Company: '<script>x</script>' }), '<p>&lt;script&gt;x&lt;/script&gt;</p>');
});
