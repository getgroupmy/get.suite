import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInvite, replyIcs, calendarPartOf } from '../src/mail/invite.js';

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Microsoft Corporation//Outlook 16.0//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
  'UID:040000008200E00074C5B7101A82E008@outlook.example', 'SEQUENCE:2', 'DTSTAMP:20261101T090000Z',
  'DTSTART:20261112T060000Z', 'DTEND:20261112T070000Z', 'SUMMARY:Quarterly review', 'LOCATION:Room 4',
  'ORGANIZER;CN="Pat Partner":mailto:Pat@Partner.example',
  'ATTENDEE;CN=Olivia;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:olivia@acme.com',
  'ATTENDEE;CN=Someone Else;PARTSTAT=ACCEPTED:mailto:else@partner.example', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

test('an invitation from another calendar: what, when, who organises it, and you on it', () => {
  const inv = readInvite(ICS, ['olivia@acme.com']);
  assert.equal(inv.method, 'REQUEST');
  assert.equal(inv.uid, '040000008200E00074C5B7101A82E008@outlook.example');
  assert.equal(inv.sequence, 2);
  assert.equal(inv.event.title, 'Quarterly review');
  assert.equal(inv.event.start, Date.UTC(2026, 10, 12, 6));
  assert.deepEqual(inv.organizer, { name: 'Pat Partner', email: 'pat@partner.example' });
  assert.deepEqual(inv.mine, { email: 'olivia@acme.com', answer: null });
  assert.equal(readInvite('not a calendar'), null);
  assert.equal(readInvite(ICS.replace('METHOD:REQUEST', 'METHOD:CANCEL'), []).method, 'CANCEL');
});

test('the answer is a METHOD:REPLY with your PARTSTAT and the event\'s UID, sequence and organizer', () => {
  const r = replyIcs(ICS, { name: 'Olivia Owner', email: 'olivia@acme.com' }, 'maybe', Date.UTC(2026, 10, 2));
  assert.match(r, /METHOD:REPLY/);
  assert.match(r, /UID:040000008200E00074C5B7101A82E008@outlook\.example/);
  assert.match(r, /SEQUENCE:2/);
  assert.match(r, /ORGANIZER;CN="Pat Partner":mailto:Pat@Partner\.example/);
  assert.match(r.replace(/\r\n /g, ''), /ATTENDEE;CN=Olivia Owner;PARTSTAT=TENTATIVE:mailto:olivia@acme\.com/);
  assert.doesNotMatch(r, /else@partner/, 'only you');
  assert.ok(r.split('\r\n').every((l) => l.length <= 75), 'folded');
});

test('the calendar part of a message', () => {
  assert.equal(calendarPartOf({ attachments: [{ contentType: 'text/calendar', content: Buffer.from(ICS) }] }), ICS);
  assert.equal(calendarPartOf({ attachments: [{ contentType: 'application/pdf', content: Buffer.from('x') }] }), null);
});
