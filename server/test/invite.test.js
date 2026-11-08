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

test('a guest\'s emailed answer (METHOD:REPLY) goes on your event, once', async () => {
  const { readReply, applyReply } = await import('../src/mail/invite.js');
  const { q } = await import('../src/db.js');
  await import('../src/routes/calendar.js'); // its tables
  const reply = ['BEGIN:VCALENDAR', 'METHOD:REPLY', 'BEGIN:VEVENT', 'UID:ev123@mail.test', 'DTSTART:20261112T060000Z', 'ATTENDEE;CN="Pat Out";PARTSTAT=DECLINED:mailto:Pat@Out.example', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const r = readReply(reply);
  assert.deepEqual(r, { uid: 'ev123@mail.test', email: 'pat@out.example', name: 'Pat Out', answer: 'no' });
  assert.equal(readReply(ICS), null, 'an invitation is not an answer');
  const org = q("SELECT id FROM users LIMIT 1").get();
  if (!org) return; // (the unit run has no users; the mail integration test covers it end to end)
  q("INSERT OR IGNORE INTO events (id, owner_id, title, start, end, all_day, exdates) VALUES ('ev123', ?, 'Review', 0, 1, 0, '[]')").run(org.id);
  q("INSERT OR IGNORE INTO event_outside_guests (event_id, email, token) VALUES ('ev123', 'pat@out.example', 'tok-ev123')").run();
  assert.equal(applyReply(org.id, r, 'mail.test').changed, true);
  assert.equal(q("SELECT status FROM event_outside_guests WHERE event_id = 'ev123'").get().status, 'no');
  assert.equal(applyReply(org.id, r, 'mail.test').changed, false, 'once');
  assert.equal(applyReply(org.id, { ...r, uid: 'ev123@elsewhere.example' }, 'mail.test'), null, 'not one of ours');
});
