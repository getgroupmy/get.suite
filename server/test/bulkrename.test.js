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

test('rename several: a new name for all (extensions kept), numbered in order, padded to the same width', async () => {
  const { byName } = await import('../src/bulkrename.js');
  assert.equal(renamed('IMG_2041.JPG', 'file', { base: 'Holiday', number: 3, digits: 2 }), 'Holiday 03.JPG');
  assert.equal(renamed('Notes', 'doc', { base: 'Minutes', number: 12, digits: 2 }), 'Minutes 12');
  assert.equal(renamed('scan.pdf', 'file', { number: 1 }), 'scan 1.pdf', 'numbered without a new name');
  assert.equal(renamed('scan.pdf', 'file', { base: 'Page-', number: 1 }), 'Page- 1.pdf', 'a space unless the name ends with one');
  assert.equal(renamed('scan.pdf', 'file', { base: 'Page ', number: 1 }), 'Page 1.pdf');
  assert.deepEqual([{ name: 'img10' }, { name: 'img2' }, { name: 'Img1' }].sort(byName).map((x) => x.name), ['Img1', 'img2', 'img10']);
});
