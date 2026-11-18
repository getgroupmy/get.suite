import { test } from 'node:test';
import assert from 'node:assert/strict';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
const { importanceOf, importantQuery, highImportanceHeaders } = await import('../src/mail/importance.js');
const { parseMailQuery } = await import('../src/mail/searchquery.js');

test('importance, as mail apps mark it', () => {
  assert.equal(importanceOf('Subject: x\r\nImportance: High\r\n'), 'high', 'Outlook');
  assert.equal(importanceOf('X-Priority: 1 (Highest)\r\n'), 'high', 'Thunderbird');
  assert.equal(importanceOf('X-Priority: 2\r\n'), 'high');
  assert.equal(importanceOf('importance: low'), 'low');
  assert.equal(importanceOf('X-Priority: 5 (Lowest)'), 'low');
  assert.equal(importanceOf('X-Priority: 3 (Normal)\r\nImportance: Normal'), null);
  assert.equal(importanceOf('Subject: Importance: High'), null, 'only the header itself');
  assert.equal(importanceOf(''), null);
});

test('a message sent as high importance carries both headers', async () => {
  const raw = (await new MailComposer({ from: 'a@acme.com', to: 'b@acme.com', subject: 'Now', text: 'x', headers: highImportanceHeaders() }).compile().build()).toString();
  assert.match(raw, /^X-Priority: 1 \(Highest\)/m);
  assert.match(raw, /^Importance: High/m);
  assert.equal(importanceOf(raw.split(/\r?\n\r?\n/)[0]), 'high');
});

test('is:important searches for either header', () => {
  assert.deepEqual(importantQuery(), { or: [{ header: { importance: 'high' } }, { or: [{ header: { 'x-priority': '1' } }, { header: { 'x-priority': '2' } }] }] });
  assert.match(JSON.stringify(parseMailQuery('is:important budget').query), /"importance":"high"/);
});
