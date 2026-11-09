import { test } from 'node:test';
import assert from 'node:assert/strict';
import { functionProblem, splitParams, cleanFunction } from './ownfuncs.js';

test('named functions: the rules for writing one', () => {
  const list = [{ name: 'WITHTAX', params: ['amount'], body: 'amount*1.2' }];
  const ok = { name: 'Margin', params: splitParams(' price,  cost ,'), body: '=(price-cost)/price' };
  assert.deepEqual(ok.params, ['price', 'cost']);
  assert.equal(functionProblem(ok, list), null);
  assert.deepEqual(cleanFunction({ ...ok, description: '  Profit share ' }), { name: 'MARGIN', params: ['price', 'cost'], body: '(price-cost)/price', description: 'Profit share' });
  assert.match(functionProblem({ ...ok, name: '' }, list), /name/);
  assert.match(functionProblem({ ...ok, name: 'Q1' }, list), /cell/);
  assert.match(functionProblem({ ...ok, name: 'sum' }, list), /SUM is already a function/);
  assert.match(functionProblem({ ...ok, name: 'withTax' }, list), /already a function with that name/);
  assert.equal(functionProblem({ ...ok, name: 'withTax' }, list, 'WITHTAX'), null, 'changing it keeps its name');
  assert.match(functionProblem({ ...ok, params: ['a1'] }, list), /argument name/);
  assert.match(functionProblem({ ...ok, params: ['x', 'X'] }, list), /its own name/);
  assert.match(functionProblem({ ...ok, body: '' }, list), /formula/);
  assert.match(functionProblem({ ...ok, body: '=SUM(price' }, list), /can’t be read/);
});
