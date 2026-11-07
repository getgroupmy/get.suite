import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutSuggestions } from '../src/office/suggestions.js';

test('downloads leave out pending suggestions', () => {
  const ins = { type: 'suggestInsert', attrs: { id: 's1' } };
  const del = { type: 'suggestDelete', attrs: { id: 's1' } };
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: 'The ' }, { type: 'text', text: 'cat', marks: [del] }, { type: 'text', text: 'dog', marks: [ins] }, { type: 'text', text: ' sat' },
    { type: 'text', text: ' still', marks: [{ type: 'bold' }, del] },
  ] }] };
  assert.deepEqual(withoutSuggestions(doc).content[0].content, [{ type: 'text', text: 'The cat sat' }, { type: 'text', text: ' still', marks: [{ type: 'bold' }] }]);
  assert.equal(doc.content[0].content.length, 5, 'the original is untouched');
});
