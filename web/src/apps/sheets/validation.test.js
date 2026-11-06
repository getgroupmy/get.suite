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
