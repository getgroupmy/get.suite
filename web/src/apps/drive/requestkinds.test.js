import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestSummary } from './requestkinds.js';

test('a file request\'s limits in words', () => {
  assert.equal(requestSummary({}), '');
  assert.equal(requestSummary({ accept: ['pictures', 'pdf'] }), 'Takes PDFs or pictures', 'in the usual order');
  assert.equal(requestSummary({ accept: ['pdf'], max_mb: 10 }), 'Takes PDFs, up to 10 MB each');
  assert.equal(requestSummary({ accept: ['documents', 'spreadsheets', 'zip'] }), 'Takes Documents, spreadsheets or zip files');
  assert.equal(requestSummary({ max_mb: 25 }), 'Files up to 25 MB each');
});
