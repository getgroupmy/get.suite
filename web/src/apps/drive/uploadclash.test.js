import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findClashes, clashQuestion } from './uploadclash.js';

const up = (id, name, dir = []) => ({ id, file: { name }, dir });

test('a name already here (exactly) clashes; other capitals, folders, docs and uploads inside a folder do not', () => {
  const here = [
    { id: 'f1', name: 'Report.pdf', kind: 'file', role: 'owner' },
    { id: 'f2', name: 'notes', kind: 'doc', role: 'owner' },
    { id: 'f3', name: 'pics', kind: 'folder', role: 'owner' },
    { id: 'f4', name: 'locked.xlsx', kind: 'file', role: 'editor', locked_at: 1 },
    { id: 'f5', name: 'theirs.png', kind: 'file', role: 'viewer' },
  ];
  const c = findClashes([up(1, 'Report.pdf'), up(8, 'report.pdf'), up(2, 'notes'), up(3, 'pics'), up(4, 'report.pdf', ['sub']), up(5, 'new.txt'), up(6, 'locked.xlsx'), up(7, 'theirs.png')], here);
  assert.deepEqual([...c.keys()], [1, 6, 7]);
  assert.deepEqual([...c.values()].map((f) => [f.id, f.canReplace]), [['f1', true], ['f4', false], ['f5', false]]);
});

test('the question names one file, or counts them', () => {
  assert.equal(clashQuestion(new Map([[1, { name: 'a.pdf' }]])), '“a.pdf” is already in this folder');
  assert.equal(clashQuestion(new Map([[1, { name: 'a' }], [2, { name: 'b' }]])), '2 files with these names are already in this folder');
});

test('a folder being uploaded whose name a folder here has (exactly)', async () => {
  const { findFolderClashes } = await import('./uploadclash.js');
  const here = [{ id: 'p', name: 'Photos', kind: 'folder' }, { id: 'r', name: 'Report', kind: 'file' }];
  const c = findFolderClashes([up(1, 'a.jpg', ['Photos', '2026']), up(2, 'b.jpg', ['Photos']), up(3, 'c.txt', ['Report']), up(4, 'd', ['photos']), up(5, 'e')], here);
  assert.deepEqual([...c.entries()].map(([n, f]) => [n, f.id]), [['Photos', 'p']]);
});
