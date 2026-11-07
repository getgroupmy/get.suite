import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateGroups, mergedFields } from '../src/contactmerge.js';

test('duplicates: by email, phone (spacing and prefix ignored) or name, chained', () => {
  const c = [
    { id: 'a', name: 'Kim Park', email: 'kim@acme.com' },
    { id: 'b', name: 'K. Park', email: 'KIM@acme.com ', phone: '+44 7700 900123' },
    { id: 'c', name: 'Kimberly', phone: '07700 900 123' },
    { id: 'd', name: 'Lee Chan', email: 'lee@x.com' },
    { id: 'e', name: 'lee  chan', company: 'X' },
    { id: 'f', name: 'Solo', phone: '123' },
    { id: 'g', name: 'Other', phone: '12 3' },
  ];
  const groups = duplicateGroups(c).map((g) => g.map((x) => x.id).sort());
  assert.deepEqual(groups, [['a', 'b', 'c'], ['d', 'e']], 'short phone numbers never match');
  assert.deepEqual(duplicateGroups([{ id: 'x', name: 'A' }, { id: 'y', name: 'B' }]), []);
});

test('merging fills the gaps, keeps what differs in the notes, joins notes', () => {
  const keep = { name: 'Kim Park', email: 'kim@acme.com', phone: null, company: 'Acme', notes: 'Met at expo' };
  const others = [
    { name: 'K. Park', email: 'KIM@acme.com', phone: '+44 7700 900123', company: 'Acme Ltd', birthday: '1990-05-01', notes: 'Likes tea' },
    { name: 'Kimberly', email: 'kim.park@gmail.com', phone: '07700 900 123', notes: 'Likes tea' },
  ];
  const m = mergedFields(keep, others);
  assert.equal(m.name, 'Kim Park');
  assert.equal(m.email, 'kim@acme.com');
  assert.equal(m.phone, '+44 7700 900123');
  assert.equal(m.birthday, '1990-05-01');
  assert.equal(m.notes, 'Met at expo\nLikes tea\nAlso company: Acme Ltd\nAlso email: kim.park@gmail.com');
  assert.equal(mergedFields({ name: 'A' }, [{ name: 'a' }]).notes, null);
});
