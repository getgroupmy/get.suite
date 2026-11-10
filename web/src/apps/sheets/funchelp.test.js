import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP, formulaContext, suggest, signatureParts } from './funchelp.js';
import { FUNCTION_NAMES } from './formula.js';

test('every function has help, and the help names only real functions', () => {
  assert.deepEqual(FUNCTION_NAMES.filter((n) => !HELP[n]), []);
  assert.deepEqual(Object.keys(HELP).filter((n) => !FUNCTION_NAMES.includes(n)), []);
});

test('the word being typed and the function the caret is inside', () => {
  assert.deepEqual(formulaContext('hello'), {});
  assert.deepEqual(formulaContext('=su'), { word: 'SU', start: 1 });
  assert.deepEqual(formulaContext('=1+vlo'), { word: 'VLO', start: 3 });
  assert.deepEqual(formulaContext('=SUM(A1, '), { fn: 'SUM', arg: 1 });
  assert.deepEqual(formulaContext('=IF(A1>2, ROUND(B1, '), { fn: 'ROUND', arg: 1 });
  assert.deepEqual(formulaContext('=IF(A1>2, ROUND(B1, 2), '), { fn: 'IF', arg: 2 });
  assert.deepEqual(formulaContext('=IF(A1="a,(b", '), { fn: 'IF', arg: 1 });
  assert.deepEqual(formulaContext('=IF(A1="su'), { fn: 'IF', arg: 0 }); // inside text: no suggestions
  assert.deepEqual(formulaContext('=SUM(A1'), { fn: 'SUM', arg: 0 }); // a cell reference, not a name
  assert.deepEqual(formulaContext('=SUM(A1:B'), { fn: 'SUM', arg: 0 });
  assert.deepEqual(formulaContext('=STDEV.'), { word: 'STDEV.', start: 1 });
  assert.deepEqual(formulaContext('=MAX(1, 2) + c', 8), { fn: 'MAX', arg: 1 }); // the caret, not the end
});

test('suggestions start with what is typed, shortest first', () => {
  assert.deepEqual(suggest('COUN', FUNCTION_NAMES), ['COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'COUNTBLANK', 'COUNTUNIQUE', 'COUNTUNIQUEIFS']);
  assert.deepEqual(suggest('stdev.', FUNCTION_NAMES), ['STDEV.P', 'STDEV.S']);
  assert.deepEqual(suggest('SUM', FUNCTION_NAMES, 3), ['SUMIF', 'SUMSQ', 'SUMIFS']);
  assert.deepEqual(suggest('', FUNCTION_NAMES), []);
});

test('signature marks the argument the caret is in', () => {
  const s = signatureParts('ROUND', 1);
  assert.deepEqual(s.parts, [{ text: 'value', current: false }, { text: '[places]', current: true }]);
  assert.equal(signatureParts('SUM', 5).parts.find((p) => p.current).text, '[value2');
  assert.equal(signatureParts('PI', 0).parts.length, 0);
  assert.equal(signatureParts('NOPE', 0), null);
});
