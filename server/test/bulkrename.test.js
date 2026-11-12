import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renamed } from '../src/bulkrename.js';

test('rename several: find and replace (any case unless asked), before and after (before the extension)', () => {
  assert.equal(renamed('Q3 report.pdf', 'file', { find: 'q3', replace: 'Q4' }), 'Q4 report.pdf');
  assert.equal(renamed('Q3 report.pdf', 'file', { find: 'q3', replace: 'Q4', matchCase: true }), 'Q3 report.pdf');
  assert.equal(renamed('report.pdf', 'file', { suffix: ' (final)' }), 'report (final).pdf');
  assert.equal(renamed('Budget', 'sheet', { suffix: ' 2027' }), 'Budget 2027', 'no extension to keep');
  assert.equal(renamed('archive.tar.gz', 'file', { suffix: '-old' }), 'archive.tar-old.gz');
  assert.equal(renamed('notes', 'file', { prefix: '2026 ', suffix: ' v2' }), '2026 notes v2');
  assert.equal(renamed('a.b.c (1).txt', 'file', { find: '(1)', replace: '' }), 'a.b.c .txt', 'symbols are plain text');
  assert.equal(renamed('Plan', 'doc', { find: 'plan', replace: '$&$1' }), '$&$1', 'no replacement patterns');
  assert.equal(renamed('Plan', 'doc', {}), 'Plan');
});
