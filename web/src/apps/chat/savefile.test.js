import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFileState } from './savefile.js';

test('withFileState marks the file gone in the messages named, and back again', () => {
  const list = [{ id: 'm1', files: [{ id: 'f1' }, { id: 'f2' }] }, { id: 'm2', files: [{ id: 'f1' }] }, { id: 'm3' }];
  const gone = withFileState(list, { message_ids: ['m1', 'm3'], file_id: 'f1', gone: true });
  assert.deepEqual(gone[0].files, [{ id: 'f1', gone: true }, { id: 'f2' }]);
  assert.equal(gone[1], list[1], 'other messages untouched');
  assert.equal(gone[2], list[2], 'no files: untouched');
  const back = withFileState(gone, { message_ids: ['m1'], file_id: 'f1', gone: false });
  assert.deepEqual(back[0].files, [{ id: 'f1' }, { id: 'f2' }]);
});
