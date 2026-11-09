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
