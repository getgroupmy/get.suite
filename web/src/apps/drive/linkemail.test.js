import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkEmail } from './linkemail.js';

test('a view link: the name, the link, until when, never the password itself', () => {
  const m = linkEmail({ name: 'Q3 <report>.pdf', kind: 'file' }, { mode: 'view', expires_at: Date.UTC(2026, 11, 1, 12), has_password: true }, 'https://ws.example/s/abc', { locale: 'en-GB' });
  assert.equal(m.subject, 'Q3 <report>.pdf');
  assert.match(m.html, /Here’s <strong>Q3 &lt;report&gt;\.pdf<\/strong>: <a href="https:\/\/ws\.example\/s\/abc">/);
  assert.match(m.html, /view it and download it without an account/);
  assert.match(m.html, /works until 1 December 2026/);
  assert.match(m.html, /password, which I’ll send you separately/);
});

test('a folder; a file request; no expiry, no password', () => {
  const f = linkEmail({ name: 'Photos', kind: 'folder' }, { mode: 'view', expires_at: null, has_password: false }, 'https://x/s/1');
  assert.match(f.html, /Here’s the folder <strong>Photos<\/strong>/);
  assert.doesNotMatch(f.html, /until|password/);
  const r = linkEmail({ name: 'Receipts', kind: 'folder' }, { mode: 'upload', expires_at: null, has_password: false }, 'https://x/s/2');
  assert.equal(r.subject, 'Please send me files: Receipts');
  assert.match(r.html, /send me your files for <strong>Receipts<\/strong> here: <a href="https:\/\/x\/s\/2">/);
  assert.match(r.html, /won’t see anyone else’s files/);
});
