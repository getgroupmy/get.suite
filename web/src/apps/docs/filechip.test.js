import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileIcon, fileLink, matchFiles } from './filechip.js';

test('file chips: an icon and a place to open for each kind of file', () => {
  assert.equal(fileIcon('doc'), '📄');
  assert.equal(fileIcon('sheet'), '📊');
  assert.equal(fileIcon('folder'), '📁');
  assert.equal(fileIcon('file', 'application/pdf'), '📕');
  assert.equal(fileIcon('file', '', 'scan.PDF'), '📕');
  assert.equal(fileIcon('file', 'image/png'), '🖼');
  assert.equal(fileIcon('file', 'text/plain'), '📎');
  assert.equal(fileLink({ id: 'a1', kind: 'doc' }), '/docs/a1');
  assert.equal(fileLink({ id: 'a1', kind: 'slides' }), '/slides/a1');
  assert.equal(fileLink({ id: 'a1', kind: 'folder' }), '/drive/folder/a1');
  assert.equal(fileLink({ id: 'a 1', kind: 'file' }), '/drive?preview=a%201');
});

test('file chips: files offered by name, names starting with it first, then the newest; not this document', () => {
  const files = [
    { id: '1', name: 'Old budget', kind: 'sheet', updated_at: 5 },
    { id: '2', name: 'Budget 2027', kind: 'sheet', updated_at: 1 },
    { id: '3', name: 'New budget notes', kind: 'doc', updated_at: 9 },
    { id: '4', name: 'Minutes', kind: 'doc', updated_at: 9 }, // matched by its words inside, not its name
    { id: '5', name: 'Budget draft', kind: 'doc', updated_at: 3 },
  ];
  assert.deepEqual(matchFiles(files, 'budget', { exclude: '5' }).map((x) => x.file.id), ['2', '3', '1']);
  assert.deepEqual(matchFiles(files, 'b'), [], 'two letters at least');
  assert.equal(matchFiles(files, 'budget', { max: 2 }).length, 2);
  assert.deepEqual(matchFiles(files, 'minutes')[0], { kind: 'file', id: 'file:4', file: { id: '4', name: 'Minutes', kind: 'doc', mime: '' } });
});
