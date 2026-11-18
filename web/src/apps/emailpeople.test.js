import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAbout } from './emailpeople.js';

test('an email to the people with access: their addresses, the file’s name, a link to it', () => {
  const m = messageAbout({ id: 'f1', kind: 'sheet', name: 'Q3 <budget>' }, [{ name: 'Kim Park', username: 'kim@acme.com' }, { name: 'vic@acme.com', username: 'vic@acme.com' }], 'https://ws.example');
  assert.equal(m.to, 'Kim Park <kim@acme.com>, vic@acme.com');
  assert.equal(m.subject, 'Q3 <budget>');
  assert.equal(m.html, '<p><a href="https://ws.example/sheets/f1">Q3 &lt;budget&gt;</a></p><p></p>');
});
