import { test } from 'node:test';
import assert from 'node:assert/strict';
const { cleanDates, cleanCustom } = await import('../src/contactfields.js');
const { buildVcard, parseVcard } = await import('../src/vcard.js');
const { contactsToCsv, contactsFromCsv } = await import('../src/contactfiles.js');

test('dates and fields are cleaned: labels, real dates, at most ten, errors when strict', () => {
  assert.deepEqual(cleanDates([{ label: ' Wedding ', date: '2015-06-20' }, { date: '--12-01' }, { label: 'x', date: 'soon' }]), [{ label: 'Wedding', date: '2015-06-20' }, { label: 'Anniversary', date: '--12-01' }]);
  assert.throws(() => cleanDates([{ label: 'Started', date: '31 Feb' }], { strict: true }), /needs a date/);
  assert.deepEqual(cleanCustom([{ label: 'Customer no.', value: ' 4711 ' }, { label: 'Empty', value: '' }]), [{ label: 'Customer no.', value: '4711' }]);
  assert.throws(() => cleanCustom([{ label: '', value: 'x' }], { strict: true }), /needs a label/);
  assert.equal(cleanCustom(Array.from({ length: 15 }, (_, i) => ({ label: `L${i}`, value: 'v' }))).length, 10);
});

test('on a vCard: dates as iPhones write them, fields with their labels; read back the same; nothing doubled', () => {
  const c = { id: 'c1', name: 'Ann Lee', dates: JSON.stringify([{ label: 'Anniversary', date: '2015-06-20' }, { label: 'Started here', date: '--03-01' }]), custom_fields: JSON.stringify([{ label: 'Customer no.', value: '4711; VIP' }]) };
  const card = buildVcard(c);
  assert.match(card, /item9001\.X-ABDATE:2015-06-20\r\nitem9001\.X-ABLabel:_\$!<Anniversary>!\$_/);
  assert.match(card, /item9002\.X-ABDATE;X-APPLE-OMIT-YEAR=1604:1604-03-01\r\nitem9002\.X-ABLabel:Started here/);
  assert.match(card, /X-WORKSPACE-FIELD;LABEL="Customer no\.":4711\\; VIP/);
  const back = parseVcard(card);
  assert.deepEqual(back.dates, [{ label: 'Anniversary', date: '2015-06-20' }, { label: 'Started here', date: '--03-01' }]);
  assert.deepEqual(back.custom_fields, [{ label: 'Customer no.', value: '4711; VIP' }]);
  assert.equal(back.vcard_extra, null, 'none of it kept twice among the other lines');
  // A card from an iPhone with its own item numbers, and a vCard 4 ANNIVERSARY.
  const phone = parseVcard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Bo Chen', 'item1.X-ABDATE;type=pref:2019-09-09', 'item1.X-ABLabel:_$!<Anniversary>!$_', 'item2.X-ABDATE:2001-01-15', 'item2.X-ABLabel:First met', 'item3.URL:https://bo.example', 'item3.X-ABLabel:_$!<HomePage>!$_', 'END:VCARD'].join('\r\n'));
  assert.deepEqual(phone.dates, [{ label: 'Anniversary', date: '2019-09-09' }, { label: 'First met', date: '2001-01-15' }]);
  assert.match(phone.vcard_extra, /item3\.URL/, 'other grouped lines are kept as they came');
  assert.deepEqual(parseVcard('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Cy\r\nANNIVERSARY:20100512\r\nEND:VCARD').dates, [{ label: 'Anniversary', date: '2010-05-12' }]);
});

test('in CSV: Gmail\'s Event and Custom Field columns, both ways', () => {
  const csv = contactsToCsv([{ name: 'Ann Lee', email: 'ann@example.com', dates: [{ label: 'Anniversary', date: '2015-06-20' }], custom_fields: [{ label: 'Customer no.', value: '4711' }] }]);
  assert.match(csv, /Event 1 - Type,Event 1 - Value,Custom Field 1 - Type,Custom Field 1 - Value/);
  const [c] = contactsFromCsv(csv);
  assert.deepEqual(c.dates, [{ label: 'Anniversary', date: '2015-06-20' }]);
  assert.deepEqual(c.custom_fields, [{ label: 'Customer no.', value: '4711' }]);
});
