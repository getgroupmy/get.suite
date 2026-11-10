import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortFiles, isPicture } from './drivesort.js';

const files = [
  { name: 'File 10', kind: 'file', size: 5, updated_at: 3 },
  { name: 'beta', kind: 'folder', updated_at: 9 },
  { name: 'File 2', kind: 'file', size: 50, updated_at: 1 },
  { name: 'Alpha', kind: 'folder', updated_at: 2 },
  { name: 'notes', kind: 'doc', size: 5, updated_at: 7 },
];
const names = (l) => l.map((f) => f.name);

test('drive sort: folders first; by name with numbers counted, by modified or size, either way', () => {
  assert.deepEqual(names(sortFiles(files)), ['Alpha', 'beta', 'File 2', 'File 10', 'notes']);
  assert.deepEqual(names(sortFiles(files, { desc: true })), ['beta', 'Alpha', 'notes', 'File 10', 'File 2']);
  assert.deepEqual(names(sortFiles(files, { sort: 'modified', desc: true })), ['beta', 'Alpha', 'notes', 'File 10', 'File 2'], 'newest first');
  assert.deepEqual(names(sortFiles(files, { sort: 'size' })), ['Alpha', 'beta', 'File 10', 'notes', 'File 2'], 'equal sizes by name');
  assert.deepEqual(names(sortFiles(files, { sort: 'size', desc: true })), ['beta', 'Alpha', 'File 2', 'notes', 'File 10']);
  assert.equal(files[0].name, 'File 10', 'the list given is left as it was');
  assert.ok(isPicture({ kind: 'file', mime: 'image/png' }));
  assert.ok(!isPicture({ kind: 'file', mime: 'image/svg+xml' }), 'no SVG thumbnails (they can carry scripts)');
  assert.ok(!isPicture({ kind: 'folder', mime: 'image/png' }));
});

test('drive sort: folders by what they hold, among themselves (still first)', () => {
  const l = [{ name: 'Small', kind: 'folder', folder_size: 10 }, { name: 'Big', kind: 'folder', folder_size: 900 }, { name: 'f', kind: 'file', size: 5000 }];
  assert.deepEqual(sortFiles(l, { sort: 'size', desc: true }).map((f) => f.name), ['Big', 'Small', 'f']);
});
