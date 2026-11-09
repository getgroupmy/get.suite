import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMore, moreFromLines, moreToLines, typeOf } from '../src/contactmore.js';
import { parseVcard, buildVcard } from '../src/vcard.js';

test('other addresses and numbers: kept clean', () => {
  assert.deepEqual(cleanMore([{ type: 'home', value: ' Kim@Home.Example ' }, { type: 'odd', value: 'x@y.co' }, { value: 'kim@acme.com' }, { value: 'nope' }], 'emails', { main: 'kim@acme.com' }),
    [{ type: 'home', value: 'kim@home.example' }, { type: 'other', value: 'x@y.co' }], 'lowercased, unknown types are other; the main one and bad ones left out');
  assert.throws(() => cleanMore([{ value: 'nope' }], 'emails', { strict: true }), /Not an email address/);
  assert.deepEqual(cleanMore([{ type: 'mobile', value: '+60 12-345 678' }, { value: '+6012345678' }], 'phones'), [{ type: 'mobile', value: '+60 12-345 678' }], 'the same number written differently counts once');
  assert.equal(cleanMore(Array.from({ length: 15 }, (_, i) => ({ value: `a${i}@b.co` })), 'emails').length, 10);
  assert.deepEqual(cleanMore('[{"type":"work","value":"a@b.co"}]', 'emails'), [{ type: 'work', value: 'a@b.co' }]);
  assert.equal(typeOf('TEL;TYPE=WORK;TYPE=VOICE', 'phones'), 'work');
  assert.equal(typeOf('item1.TEL;type=iPhone', 'phones'), 'mobile');
});

test('on a card: lines in and out', () => {
  const { emails, phones, rest } = moreFromLines(['EMAIL;TYPE=HOME:a@b.co', 'TEL;TYPE=CELL:+1 555', 'X-FOO:bar']);
  assert.deepEqual([emails, phones, rest], [[{ type: 'home', value: 'a@b.co' }], [{ type: 'mobile', value: '+1 555' }], ['X-FOO:bar']]);
  assert.deepEqual(moreToLines([{ type: 'work', value: 'w@b.co' }], [{ type: 'mobile', value: '+1 555' }, { type: 'home', value: '+1 666' }]),
    ['EMAIL;TYPE=INTERNET,WORK:w@b.co', 'TEL;TYPE=CELL:+1 555', 'TEL;TYPE=HOME,VOICE:+1 666']);
  const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Kim Park\r\nEMAIL;TYPE=INTERNET;TYPE=WORK;TYPE=pref:kim@acme.com\r\nitem2.EMAIL;type=INTERNET;type=HOME:kim@home.example\r\nTEL;TYPE=CELL:+60 12 345\r\nTEL;TYPE=WORK;TYPE=VOICE:+60 3 999\r\nX-FOO:bar\r\nEND:VCARD\r\n';
  const c = parseVcard(card);
  assert.equal(c.email, 'kim@acme.com');
  assert.deepEqual(c.more_emails, [{ type: 'home', value: 'kim@home.example' }]);
  assert.deepEqual(c.more_phones, [{ type: 'work', value: '+60 3 999' }]);
  assert.equal(c.vcard_extra, 'X-FOO:bar', 'not kept twice');
  const back = parseVcard(buildVcard({ id: 'x', ...c }));
  assert.deepEqual([back.email, back.phone, back.more_emails, back.more_phones], [c.email, c.phone, c.more_emails, c.more_phones], 'the same after a round trip');
});

test('CSV: other addresses and numbers from Gmail and Outlook exports, and back out', async () => {
  const { contactsFromCsv, contactsToCsv } = await import('../src/contactfiles.js');
  const gmail = 'Name,Given Name,E-mail 1 - Type,E-mail 1 - Value,E-mail 2 - Type,E-mail 2 - Value,Phone 1 - Type,Phone 1 - Value,Phone 2 - Type,Phone 2 - Value\n'
    + 'Kim Park,Kim,* Work,kim@acme.com,Home,kim@home.example ::: kim2@home.example,Mobile,+60 12 345,Work,+60 3 999\n';
  const [g] = contactsFromCsv(gmail);
  assert.deepEqual([g.email, g.phone], ['kim@acme.com', '+60 12 345']);
  assert.deepEqual(g.more_emails, [{ type: 'home', value: 'kim@home.example' }, { type: 'home', value: 'kim2@home.example' }]);
  assert.deepEqual(g.more_phones, [{ type: 'work', value: '+60 3 999' }]);
  const outlook = 'First Name,Last Name,E-mail Address,E-mail 2 Address,Mobile Phone,Business Phone,Home Phone\nLena,Lark,lena@work.example,lena@home.example,+44 7700 900111,+44 20 7946 0000,\n';
  const [o] = contactsFromCsv(outlook);
  assert.deepEqual([o.name, o.email, o.phone], ['Lena Lark', 'lena@work.example', '+44 7700 900111']);
  assert.deepEqual(o.more_emails, [{ type: 'other', value: 'lena@home.example' }]);
  assert.deepEqual(o.more_phones, [{ type: 'work', value: '+44 20 7946 0000' }]);
  const plain = contactsFromCsv('Name,Email,Phone\nBo,bo@x.com,123 456\n');
  assert.deepEqual([plain[0].email, plain[0].phone, plain[0].more_emails, plain[0].more_phones], ['bo@x.com', '123 456', [], []]);
  // Out as Gmail-style columns, and read back the same.
  const csv = contactsToCsv([{ name: 'Kim Park', email: 'kim@acme.com', phone: '+60 12 345', more_emails: [{ type: 'home', value: 'kim@home.example' }], more_phones: '[{"type":"work","value":"+60 3 999"},{"type":"mobile","value":"+60 19 1"}]' }, { name: 'Bo', email: 'bo@x.com' }]);
  assert.match(csv.split('\r\n')[0], /,E-mail 2 - Type,E-mail 2 - Value,Phone 2 - Type,Phone 2 - Value,Phone 3 - Type,Phone 3 - Value$/);
  const [back] = contactsFromCsv(csv);
  assert.deepEqual([back.email, back.phone, back.more_emails, back.more_phones], ['kim@acme.com', '+60 12 345', [{ type: 'home', value: 'kim@home.example' }], [{ type: 'work', value: '+60 3 999' }, { type: 'mobile', value: '+60 19 1' }]]);
  assert.match(contactsToCsv([{ name: 'Ann' }]).split('\r\n')[0], /Web Page$/, 'no extra columns when nobody has more');
});
