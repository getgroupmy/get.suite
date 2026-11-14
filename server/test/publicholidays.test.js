import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easter, nth, publicHolidays, COUNTRIES } from '../src/publicholidays.js';

const dates = (c, y) => publicHolidays(c, y).map((h) => `${h.date} ${h.name}`);

test('Easter, and "the nth weekday of a month"', () => {
  const iso = (d) => d.toISOString().slice(0, 10);
  assert.deepEqual([2024, 2025, 2026, 2027, 2038].map((y) => iso(easter(y))), ['2024-03-31', '2025-04-20', '2026-04-05', '2027-03-28', '2038-04-25']);
  assert.equal(iso(nth(2026, 11, 4, 4)), '2026-11-26'); // Thanksgiving
  assert.equal(iso(nth(2026, 5, 1, -1)), '2026-05-25'); // last Monday of May
  assert.equal(iso(nth(2026, 9, 1, 1)), '2026-09-07');
});

test('United Kingdom: bank holidays, with substitute days when Christmas falls at a weekend', () => {
  assert.deepEqual(dates('GB', 2026), ["2026-01-01 New Year's Day", '2026-04-03 Good Friday', '2026-04-06 Easter Monday', '2026-05-04 Early May bank holiday',
    '2026-05-25 Spring bank holiday', '2026-08-31 Summer bank holiday', '2026-12-25 Christmas Day', '2026-12-28 Boxing Day (substitute day)']);
  // Christmas on a Sunday (2022): Boxing Day Monday 26th, Christmas moves to Tuesday 27th.
  assert.deepEqual(dates('gb', 2022).slice(-2), ['2022-12-26 Boxing Day', '2022-12-27 Christmas Day (substitute day)']);
  // Christmas on a Saturday (2027): Monday 27th and Tuesday 28th.
  assert.deepEqual(dates('GB', 2027).slice(-2), ['2027-12-27 Christmas Day (substitute day)', '2027-12-28 Boxing Day (substitute day)']);
});

test('United States (federal): Monday holidays and observed days', () => {
  const us = dates('US', 2026);
  assert.equal(us.length, 11);
  assert.ok(us.includes('2026-01-19 Martin Luther King Jr. Day'));
  assert.ok(us.includes('2026-07-03 Independence Day'), 'July 4th 2026 is a Saturday: observed Friday');
  assert.ok(us.includes('2026-11-26 Thanksgiving Day'));
  assert.ok(dates('US', 2027).includes('2027-12-24 Christmas Day'));
  assert.ok(!dates('US', 2020).some((d) => /Juneteenth/.test(d)), 'from 2021');
});

test('other countries: Easter-based days and their own rules', () => {
  assert.ok(dates('DE', 2026).includes('2026-05-14 Christi Himmelfahrt'));
  assert.ok(dates('DE', 2026).includes('2026-05-25 Pfingstmontag'));
  assert.ok(dates('FR', 2026).includes('2026-07-14 Fête nationale'));
  assert.ok(dates('NL', 2025).includes('2025-04-26 Koningsdag'), "King's Day on a Sunday moves to Saturday");
  assert.ok(dates('IE', 2026).includes("2026-02-02 St Brigid's Day"));
  assert.ok(dates('IE', 2030).includes("2030-02-01 St Brigid's Day"), 'February 1st on a Friday');
  assert.ok(dates('CA', 2026).includes('2026-05-18 Victoria Day'));
  assert.ok(dates('CA', 2029).includes('2029-07-02 Canada Day'), 'July 1st on a Sunday');
  assert.ok(dates('AU', 2026).includes('2026-01-26 Australia Day'));
  assert.ok(dates('AU', 2027).includes('2027-12-27 Christmas Day (substitute day)'));
  assert.ok(dates('AU', 2026).includes('2026-04-25 Anzac Day'), 'not moved');
  assert.equal(publicHolidays('XX', 2026), null);
  assert.equal(publicHolidays('GB', 'soon'), null);
  assert.equal(COUNTRIES.length, 8);
  for (const { code } of COUNTRIES) {
    const list = publicHolidays(code, 2026);
    assert.ok(list.length >= 7, code);
    assert.equal(new Set(list.map((h) => h.date)).size, list.length, `${code}: one per day`);
    assert.deepEqual(list.map((h) => h.date), [...list.map((h) => h.date)].sort(), `${code}: in order`);
  }
});
