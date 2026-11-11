import test from 'node:test';
import assert from 'node:assert/strict';
import { eventEmail } from './eventemail.js';

test('eventEmail: to the organizer and guests but not you, with when, where and a link', () => {
  const ev = { title: 'Budget <review>', location: 'Room 2', organizer: { name: 'Olivia Owner', email: 'olivia@acme.com' },
    guests: [{ email: 'kim@acme.com', name: 'Kim Park', status: 'yes' }, { email: 'olivia@acme.com', status: 'yes' }, { email: 'out@client.test', status: 'no' }, { email: 'KIM@acme.com' }] };
  const m = eventEmail(ev, 'olivia@acme.com', { when: 'Tue 10 Nov, 14:00 – 15:00', link: 'https://ws.test/calendar?event=e1' });
  assert.equal(m.to, '"Kim Park" <kim@acme.com>, out@client.test', 'once each, not me');
  assert.equal(m.subject, 'Budget <review>');
  assert.match(m.html, /<strong>When:<\/strong> Tue 10 Nov, 14:00 – 15:00/);
  assert.match(m.html, /<strong>Where:<\/strong> Room 2/);
  assert.match(m.html, /<a href="https:\/\/ws\.test\/calendar\?event=e1">Budget &lt;review&gt; in Calendar<\/a>/);
  assert.equal(eventEmail(ev, 'kim@acme.com', { skipDeclined: true }).to, '"Olivia Owner" <olivia@acme.com>', 'a guest writes to the organizer and the others; declined left out');
});
