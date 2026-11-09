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
