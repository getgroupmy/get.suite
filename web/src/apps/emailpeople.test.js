import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAbout, meetingAbout } from './emailpeople.js';

test('an email to the people with access: their addresses, the file’s name, a link to it', () => {
  const m = messageAbout({ id: 'f1', kind: 'sheet', name: 'Q3 <budget>' }, [{ name: 'Kim Park', username: 'kim@acme.com' }, { name: 'vic@acme.com', username: 'vic@acme.com' }], 'https://ws.example');
  assert.equal(m.to, 'Kim Park <kim@acme.com>, vic@acme.com');
  assert.equal(m.subject, 'Q3 <budget>');
  assert.equal(m.html, '<p><a href="https://ws.example/sheets/f1">Q3 &lt;budget&gt;</a></p><p></p>');
});

test('a meeting with the people with access: them as guests, at the next whole hour, the file attached and linked', () => {
  const now = new Date(2026, 10, 18, 13, 47).getTime();
  const ev = meetingAbout({ id: 'd1', kind: 'doc', name: 'Launch plan' }, [{ name: 'Kim', username: 'kim@acme.com' }], 'https://ws.example', now);
  assert.equal(ev.start, new Date(2026, 10, 18, 14, 0).getTime());
  assert.equal(ev.end - ev.start, 3600e3);
  assert.deepEqual(ev.guests, [{ email: 'kim@acme.com' }]);
  assert.equal(ev.title, 'Launch plan');
  assert.equal(ev.description, 'About “Launch plan”: https://ws.example/docs/d1');
  assert.deepEqual(ev.attachments, [{ id: 'd1', name: 'Launch plan', kind: 'doc', mime: null }]);
});

test('a plain Drive file links to it in Drive', () => {
  assert.equal(messageAbout({ id: 'p1', kind: 'file', name: 'Brief.pdf' }, [], 'https://ws.example').html, '<p><a href="https://ws.example/drive?file=p1">Brief.pdf</a></p><p></p>');
  assert.equal(meetingAbout({ id: 'p1', kind: 'file', name: 'Brief.pdf' }, [], 'https://ws.example', 0).description, 'About “Brief.pdf”: https://ws.example/drive?file=p1');
});
