import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanOptions, chipChoice, chipText, CHIP_PRESETS, MAX_OPTIONS } from './dropchip.js';

test('cleanOptions tidies typed choices and gives each a colour', () => {
  const o = cleanOptions('  To do \n\nDoing\nto do\nDone   now');
  assert.deepEqual(o.map((x) => x.label), ['To do', 'Doing', 'Done now']);
  assert.deepEqual(o.map((x) => x.color), ['grey', 'blue', 'green']);
  assert.equal(cleanOptions(Array.from({ length: 20 }, (_, i) => `Option ${i}`)).length, MAX_OPTIONS);
  assert.equal(cleanOptions(['x'.repeat(80)])[0].label.length, 40);
  assert.deepEqual(cleanOptions([{ label: 'Red one', color: 'red' }, { label: 'Odd', color: 'javascript:' }]), [{ label: 'Red one', color: 'red' }, { label: 'Odd', color: 'blue' }]);
  assert.deepEqual(cleanOptions(null), []);
});

test('a chip reads as its choice, or its first choice before one is picked', () => {
  const options = CHIP_PRESETS[0].options;
  assert.equal(chipText({ options, value: 'Done' }), 'Done');
  assert.equal(chipChoice({ options, value: 'Done' }).color, 'green');
  assert.equal(chipText({ options, value: null }), 'Not started');
  assert.equal(chipChoice({ options, value: 'Gone' }), null);
  assert.equal(chipText({ options: [], value: null }), '—');
});
