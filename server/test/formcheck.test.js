import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanCheck, checkProblem, patternProblem } from '../src/formcheck.js';

test("the web app's copy of the form rules matches the server's", () => {
  const read = (u) => fs.readFileSync(new URL(u, import.meta.url), 'utf8');
  assert.equal(read('../../web/src/apps/forms/formcheck.js'), read('../src/formcheck.js'));
});

test('response validation: numbers', () => {
  const r = cleanCheck('short', { kind: 'number', op: 'between', a: '10', b: 1 });
  assert.deepEqual(r, { kind: 'number', op: 'between', a: 1, b: 10 });
  assert.equal(checkProblem(r, '5'), null);
  assert.equal(checkProblem(r, '1,000'), 'Enter a number from 1 to 10');
  assert.equal(checkProblem(r, 'five'), 'Enter a number');
  assert.equal(checkProblem(r, ''), null, 'empty is left to Required');
  assert.equal(checkProblem({ kind: 'number', op: 'whole' }, '2.5'), 'Enter a whole number');
  assert.equal(checkProblem({ kind: 'number', op: 'gt', a: 0 }, '-1'), 'Enter a number greater than 0');
  assert.equal(checkProblem({ kind: 'number', op: 'gt', a: 0, msg: 'Must be positive' }, '0'), 'Must be positive');
  assert.throws(() => cleanCheck('short', { kind: 'number', op: 'gt', a: '' }), /Enter a number/);
  assert.equal(cleanCheck('date', { kind: 'number', op: 'gt', a: 1 }), null, 'not for dates');
});

test('response validation: text, length, patterns and tick boxes', () => {
  assert.equal(checkProblem({ kind: 'text', op: 'email' }, 'ann@acme.com'), null);
  assert.equal(checkProblem({ kind: 'text', op: 'email' }, 'ann@'), 'Enter an email address');
  assert.equal(checkProblem({ kind: 'text', op: 'url' }, 'acme.com/shop'), null);
  assert.equal(checkProblem({ kind: 'text', op: 'url' }, 'not a site'), 'Enter a web address');
  assert.equal(checkProblem({ kind: 'text', op: 'contains', a: 'ACME' }, 'at acme today'), null);
  assert.match(checkProblem({ kind: 'text', op: 'notcontains', a: 'spam' }, 'Spam!'), /can't contain/);
  assert.equal(checkProblem({ kind: 'length', op: 'maxlen', a: 5 }, 'abcdefg'), 'Use at most 5 characters (now 7)');
  assert.equal(checkProblem({ kind: 'length', op: 'minlen', a: 1 }, 'a'), null);
  assert.equal(checkProblem({ kind: 'pattern', op: 'matches', a: '^[A-Z]{2}\\d{4}$' }, 'AB1234'), null);
  assert.ok(checkProblem({ kind: 'pattern', op: 'matches', a: '^[A-Z]{2}\\d{4}$' }, 'ab12'));
  assert.equal(patternProblem('(a+)+$'), 'That pattern is too complicated');
  assert.equal(patternProblem('(['), 'That isn\'t a valid pattern');
  assert.throws(() => cleanCheck('paragraph', { kind: 'pattern', op: 'matches', a: '(x*)*' }), /too complicated/);
  const pick = cleanCheck('checkbox', { kind: 'count', op: 'atmost', a: 2 });
  assert.equal(checkProblem(pick, ['a', 'b']), null);
  assert.equal(checkProblem(pick, ['a', 'b', 'c']), 'Choose at most 2');
  assert.equal(checkProblem({ kind: 'count', op: 'exactly', a: 2 }, ['a']), 'Choose exactly 2');
  assert.throws(() => cleanCheck('checkbox', { kind: 'count', op: 'atleast', a: 1.5 }), /whole number/);
});
