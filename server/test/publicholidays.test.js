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
  assert.equal(COUNTRIES.length, 18);
  for (const { code } of COUNTRIES) {
    const list = publicHolidays(code, 2026);
    assert.ok(list.length >= 7, code);
    assert.equal(new Set(list.map((h) => h.date)).size, list.length, `${code}: one per day`);
    assert.deepEqual(list.map((h) => h.date), [...list.map((h) => h.date)].sort(), `${code}: in order`);
  }
});

test('more of Europe, and South Africa', () => {
  assert.ok(dates('ES', 2026).includes('2026-04-03 Viernes Santo'));
  assert.ok(dates('ES', 2026).includes('2026-10-12 Fiesta Nacional de España'));
  assert.ok(dates('IT', 2026).includes("2026-10-04 San Francesco d'Assisi"), 'a national holiday again from 2026');
  assert.ok(!dates('IT', 2025).some((d) => /Francesco/.test(d)));
  assert.ok(dates('IT', 2026).includes('2026-04-05 Pasqua'));
  assert.ok(dates('BE', 2026).includes('2026-07-21 National Day'));
  assert.ok(dates('AT', 2026).includes('2026-06-04 Fronleichnam'), 'Corpus Christi: 60 days after Easter');
  assert.ok(dates('AT', 2026).includes('2026-10-26 Nationalfeiertag'));
  assert.ok(dates('PT', 2026).includes('2026-12-01 Restauração da Independência'));
  assert.ok(!dates('PT', 2014).some((d) => /Corpo de Deus|Restauração/.test(d)), 'suspended 2013–2015');
  assert.ok(dates('PL', 2025).includes('2025-12-24 Wigilia Bożego Narodzenia'), 'from 2025');
  assert.ok(!dates('PL', 2024).some((d) => /Wigilia/.test(d)));
  assert.ok(dates('DK', 2023).includes('2023-05-05 Store bededag'));
  assert.ok(!dates('DK', 2024).some((d) => /bededag/.test(d)), 'abolished from 2024');
  assert.ok(dates('NO', 2026).includes('2026-05-17 Grunnlovsdag'));
  assert.ok(dates('SE', 2026).includes('2026-06-20 Midsommardagen'), 'the Saturday from 20 June');
  assert.ok(dates('SE', 2025).includes('2025-06-21 Midsommardagen'));
  assert.ok(dates('SE', 2025).includes('2025-11-01 Alla helgons dag'));
  // South Africa: a Sunday holiday gives the Monday off, but not twice over.
  assert.ok(dates('ZA', 2026).includes("2026-08-10 National Women's Day (observed)"));
  assert.ok(dates('ZA', 2026).includes("2026-08-09 National Women's Day"));
  assert.ok(!dates('ZA', 2022).some((d) => /Christmas Day \(observed\)/.test(d)), 'Christmas on a Sunday: the 26th is already off');
});
