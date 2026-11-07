import { test } from 'node:test';
import assert from 'node:assert/strict';
import { birthdayOf, birthdaysBetween } from '../src/birthday.js';
import { parseVcard, buildVcard } from '../src/vcard.js';
import { contactsFromCsv, contactsToCsv } from '../src/contactfiles.js';

test('birthdays in the forms people have', () => {
  assert.equal(birthdayOf('1990-05-17'), '1990-05-17');
  assert.equal(birthdayOf('19900517'), '1990-05-17');
  assert.equal(birthdayOf('1990-05-17T00:00:00Z'), '1990-05-17');
  assert.equal(birthdayOf('--0517'), '--05-17');
  assert.equal(birthdayOf('--05-17'), '--05-17');
  assert.equal(birthdayOf('1604-05-17'), '--05-17', 'Apple: no year');
  assert.equal(birthdayOf('5/17/1990'), '1990-05-17');
  assert.equal(birthdayOf('--02-29'), '--02-29');
  assert.equal(birthdayOf('2023-02-29'), null);
  assert.equal(birthdayOf('1990-13-01'), null);
  assert.equal(birthdayOf(''), null);
  assert.throws(() => birthdayOf('soon', { strict: true }));
});

test('birthdays in a date range, with ages; 29 February on the 28th', () => {
  assert.deepEqual(birthdaysBetween('1990-05-17', '2026-01-01', '2026-12-31'), [{ date: '2026-05-17', age: 36 }]);
  assert.deepEqual(birthdaysBetween('--05-17', '2026-05-01', '2026-05-31'), [{ date: '2026-05-17', age: null }]);
  assert.deepEqual(birthdaysBetween('1990-05-17', '2026-06-01', '2026-06-30'), []);
  assert.deepEqual(birthdaysBetween('2000-02-29', '2026-02-01', '2026-03-01'), [{ date: '2026-02-28', age: 26 }]);
  assert.deepEqual(birthdaysBetween('2000-02-29', '2028-02-01', '2028-03-01'), [{ date: '2028-02-29', age: 28 }]);
  assert.deepEqual(birthdaysBetween('1990-12-30', '2026-12-28', '2027-01-03'), [{ date: '2026-12-30', age: 36 }]);
  assert.deepEqual(birthdaysBetween('2030-01-01', '2026-01-01', '2026-12-31'), [], 'not born yet');
});

test('birthdays travel on vCards and CSV', () => {
  const card = buildVcard({ id: 'x', name: 'Ann Lee', birthday: '1990-05-17' });
  assert.match(card, /BDAY:1990-05-17/);
  assert.equal(parseVcard(card).birthday, '1990-05-17');
  const noYear = buildVcard({ id: 'y', name: 'Bo', birthday: '--05-17' });
  assert.match(noYear, /BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-17/);
  assert.equal(parseVcard(noYear).birthday, '--05-17');
  assert.doesNotMatch(parseVcard(card).vcard_extra || '', /BDAY/, 'not kept twice');
  assert.equal(parseVcard('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Cy\r\nBDAY:--1224\r\nEND:VCARD\r\n').birthday, '--12-24');
  const csv = contactsFromCsv('Name,E-mail 1 - Value,Birthday\nAnn,ann@x.com,1990-05-17\nBo,bo@x.com,--05-17\n');
  assert.deepEqual(csv.map((c) => c.birthday), ['1990-05-17', '--05-17']);
  assert.match(contactsToCsv([{ name: "Ann", birthday: "1990-05-17" }]), /,Web Page\r\nAnn,,,,,1990-05-17,,,/);
});

test('job title, address and web page travel on cards and CSV; a phone’s address line is kept as it came', () => {
  const card = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Mei Tan', 'TITLE:Sales Manager', 'item1.ADR;type=WORK;type=pref:;;1 Jalan Pantai;George Town;;10300;Malaysia', 'URL:https://harbour.example', 'END:VCARD'].join('\r\n');
  const c = parseVcard(card);
  assert.deepEqual([c.title, c.address, c.website], ['Sales Manager', '1 Jalan Pantai\nGeorge Town\n10300\nMalaysia', 'https://harbour.example']);
  const same = buildVcard({ id: 'x', ...c });
  assert.match(same, /item1\.ADR;type=WORK;type=pref:;;1 Jalan Pantai;George Town;;10300;Malaysia/, 'unchanged: the phone’s own line');
  const moved = buildVcard({ id: 'x', ...c, address: '9 New Road\nIpoh' });
  assert.doesNotMatch(moved, /Jalan Pantai/);
  assert.match(moved, /ADR;TYPE=WORK:;;9 New Road\\nIpoh;;;;/);
  assert.equal(parseVcard(moved).address, '9 New Road\nIpoh');
  assert.match(same, /TITLE:Sales Manager/);
  const csv = contactsFromCsv('Name,Job Title,Address,Website\nAnn,Engineer,"1 Main St, Ipoh",ann.example.com\n');
  assert.deepEqual([csv[0].title, csv[0].address, csv[0].website], ['Engineer', '1 Main St, Ipoh', 'ann.example.com']);
});
