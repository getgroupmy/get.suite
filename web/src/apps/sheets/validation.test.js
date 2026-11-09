import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validationAt, parseChoices, checkEntry, isTicked, describeValidation } from './validation.js';

const list = { id: 'a', range: 'B2:B10', type: 'list', values: ['Open', 'In progress', 'Done'], strict: true };
const box = { id: 'b', range: 'C2:C10', type: 'checkbox' };

test('which validation a cell has; later ones win', () => {
  assert.equal(validationAt([list, box], 'B3'), list);
  assert.equal(validationAt([list, box], 'C2'), box);
  assert.equal(validationAt([list, box], 'A1'), null);
  const over = { ...box, id: 'c', range: 'B5:B5' };
  assert.equal(validationAt([list, over], 'B5'), over);
});

test('choices from what was typed', () => {
  assert.deepEqual(parseChoices(' Open, In progress ,\nDone\n\nopen, '), ['Open', 'In progress', 'Done']);
  assert.deepEqual(parseChoices(''), []);
});

test('entries: corrected to the choice, refused if strict, free if not', () => {
  assert.deepEqual(checkEntry(list, 'done'), { value: 'Done' });
  assert.ok(checkEntry(list, 'Maybe').error.startsWith('Choose one of: Open, In progress, Done'));
  assert.deepEqual(checkEntry({ ...list, strict: false }, 'Maybe'), { value: 'Maybe' });
  assert.deepEqual(checkEntry(list, ''), { value: '' });
  assert.deepEqual(checkEntry(list, '=A1'), { value: '=A1' }, 'formulas are left alone');
  assert.deepEqual(checkEntry(null, 'x'), { value: 'x' });
});

test('tick boxes take yes/no in many spellings', () => {
  assert.deepEqual(checkEntry(box, 'yes'), { value: 'TRUE' });
  assert.deepEqual(checkEntry(box, '0'), { value: 'FALSE' });
  assert.ok(checkEntry(box, 'maybe').error);
  assert.equal(isTicked(true), true);
  assert.equal(isTicked('TRUE'), true);
  assert.equal(isTicked(false), false);
  assert.equal(isTicked(null), false);
});

test('described in words', () => {
  assert.equal(describeValidation(list), 'Dropdown: Open, In progress, Done');
  assert.equal(describeValidation(box), 'Tick box');
  assert.match(describeValidation({ type: 'list', values: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), /and 2 more \(other values allowed\)/);
});

test('a dropdown can take its choices from a range, on this sheet or another', async () => {
  const { parseSource, cleanSource, choicesFrom, withChoices, describeValidation: describe } = await import('./validation.js');
  assert.deepEqual(parseSource('Lists!A2:A4'), { sheet: 'Lists', c1: 0, c2: 0, r1: 1, r2: 3 });
  assert.deepEqual(parseSource("'Q1 data'!$B$9:$B$2"), { sheet: 'Q1 data', c1: 1, c2: 1, r1: 1, r2: 8 });
  assert.equal(parseSource('D2:D10').sheet, null);
  assert.equal(parseSource('nonsense'), null);
  assert.equal(cleanSource('lists!$a$2:$a$4'), 'lists!A2:A4');
  assert.equal(cleanSource("'Q1 data'!b2:b9"), "'Q1 data'!B2:B9");
  assert.equal(cleanSource('d2'), 'D2:D2');
  const sheets = { Lists: { A2: 'Open', A3: 'open', A4: '', A5: 7, A6: { error: '#REF!' }, A7: 'Done' } };
  const valueOf = (sheet, key) => (sheet ? sheets[sheet]?.[key] : { D2: 'Here' }[key]);
  assert.deepEqual(choicesFrom('Lists!A2:A7', valueOf), ['Open', '7', 'Done'], 'blanks, errors and repeats left out; numbers as shown');
  assert.deepEqual(choicesFrom('D2:D3', valueOf), ['Here']);
  assert.deepEqual(choicesFrom('Missing!A1:A5', valueOf), []);
  const v = { type: 'list', source: 'Lists!A2:A7', strict: true };
  assert.deepEqual(withChoices(v, valueOf).values, ['Open', '7', 'Done']);
  assert.deepEqual(checkEntry(withChoices(v, valueOf), 'done'), { value: 'Done' });
  assert.ok(checkEntry(withChoices(v, valueOf), 'Later').error);
  assert.equal(describe(v), 'Dropdown from Lists!A2:A7');
});

test('choices can have colours', async () => {
  const { chipColour, cleanColours } = await import('./validation.js');
  const v = { type: 'list', values: ['Open', 'Done'], colors: { Done: '#CEEAD6', Open: 'red' } };
  assert.equal(chipColour(v, 'done'), '#ceead6');
  assert.equal(chipColour(v, 'Open'), null, 'not a colour');
  assert.equal(chipColour(v, ''), null);
  assert.equal(chipColour({ type: 'checkbox', colors: { TRUE: '#ffffff' } }, 'TRUE'), null);
  assert.deepEqual(cleanColours({ Done: '#CEEAD6', Gone: '#ffffff', Bad: 'x' }, ['done']), { Done: '#ceead6' });
  assert.equal(cleanColours({}, ['a']), null);
});

test('rules: numbers, whole numbers, dates, text length, email and web addresses', async () => {
  const { passes, checkEntry, breaksRule, describeCheck, describeValidation } = await import('./validation.js');
  const n = { kind: 'number', op: 'between', a: '1', b: '10' };
  assert.deepEqual(['5', '10', '1.5', '11', 'abc', 0, ''].map((x) => passes(n, x)), [true, true, true, false, false, false, true]);
  assert.deepEqual(['3', '3.5'].map((x) => passes({ ...n, kind: 'whole' }, x)), [true, false]);
  assert.deepEqual([5, 11].map((x) => passes({ kind: 'number', op: 'notBetween', a: '1', b: '10' }, x)), [false, true]);
  assert.deepEqual([-1, 0, 1].map((x) => passes({ kind: 'number', op: 'gte', a: '0' }, x)), [false, true, true]);
  assert.equal(passes({ kind: 'number', op: 'gt' }, '7'), true, 'no limit set: any number');
  const d = { kind: 'date', op: 'gt', a: '2026-01-01' };
  assert.deepEqual(['2026-01-02', '2026-01-01', '2025-12-31', 'soon', '2026-02-30'].map((x) => passes(d, x)), [true, false, false, false, false]);
  assert.deepEqual(['2026-03-01', '2026-06-01'].map((x) => passes({ kind: 'date', op: 'between', a: '2026-02-01', b: '2026-04-30' }, x)), [true, false]);
  assert.deepEqual(['abc', 'abcdef'].map((x) => passes({ kind: 'length', op: 'lte', a: '5' }, x)), [true, false]);
  assert.deepEqual(['ana@acme.com', 'ana@acme', 'not an email'].map((x) => passes({ kind: 'email' }, x)), [true, false, false]);
  assert.deepEqual(['https://acme.com/x', 'acme.com', 'acme'].map((x) => passes({ kind: 'url' }, x)), [true, true, false]);
  // Typing into the cell.
  const strict = { type: 'rule', check: n, strict: true };
  assert.deepEqual(checkEntry(strict, '4'), { value: '4' });
  assert.deepEqual(checkEntry(strict, '40'), { error: 'Enter a value that fits: number between 1 and 10' });
  assert.deepEqual(checkEntry({ ...strict, message: 'A quantity from 1 to 10' }, '40'), { error: 'A quantity from 1 to 10' });
  assert.deepEqual(checkEntry({ ...strict, strict: false }, '40'), { value: '40', warning: 'Enter a value that fits: number between 1 and 10' });
  assert.deepEqual(checkEntry(strict, '=A1*100'), { value: '=A1*100' }, 'formulas are checked by their marks');
  assert.equal(breaksRule({ ...strict, range: 'A1:A5' }, 'A2', 40), true);
  assert.equal(breaksRule({ ...strict, range: 'A1:A5' }, 'A2', ''), false);
  assert.equal(describeCheck({ kind: 'date', op: 'lte', a: '2026-12-31' }), 'Date on or before 2026-12-31');
  assert.equal(describeValidation({ type: 'rule', check: { kind: 'email' }, strict: false }), 'Email address (other values marked)');
});

test('rules: a custom formula, moved along the range', async () => {
  const { breaksRule } = await import('./validation.js');
  const { createEvaluator } = await import('./formula.js');
  const ev = createEvaluator({ B2: '2026-01-05', C2: '2026-01-10', B3: '2026-02-05', C3: '2026-01-10' });
  const v = { type: 'rule', range: 'B2:B3', check: { kind: 'formula', a: '=B2<=C2' }, strict: false };
  assert.equal(breaksRule(v, 'B2', ev('B2'), ev.formulaAt), false);
  assert.equal(breaksRule(v, 'B3', ev('B3'), ev.formulaAt), true, 'starts after it ends');
});
