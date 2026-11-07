import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventFromEmail } from './fromemail.js';

test('an email becomes an event: subject, guests but you, text, the next half hour', () => {
  const now = new Date(2026, 10, 7, 10, 10).getTime();
  const e = eventFromEmail({
    subject: 'Re: FW: Quarterly review', text: 'Shall we meet?\r\n\n\n\nThanks',
    from: { name: 'Raj', address: 'Raj@globex.com' }, to: [{ address: 'olivia@acme.com' }, { address: 'kim@acme.com' }], cc: [{ address: 'raj@globex.com' }],
  }, ['OLIVIA@acme.com'], now);
  assert.equal(e.title, 'Quarterly review');
  assert.deepEqual(e.guests, [{ email: 'raj@globex.com' }, { email: 'kim@acme.com' }]);
  assert.equal(e.description, 'Shall we meet?\n\nThanks');
  assert.equal(e.start, new Date(2026, 10, 7, 10, 30).getTime());
  assert.equal(e.end - e.start, 36e5);
});

test('a long email is cut; nothing on it is fine', () => {
  assert.equal(eventFromEmail({ text: 'x'.repeat(5000) }, []).description.length, 4000);
  const e = eventFromEmail({}, []);
  assert.equal(e.title, '');
  assert.deepEqual(e.guests, []);
});
