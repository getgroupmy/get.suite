import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRequest, accepts, acceptText, acceptAttr } from '../src/filerequest.js';

test('kinds of file: by the name\'s extension, any case; none chosen: anything', () => {
  assert.equal(accepts(null, 'a.exe'), true);
  assert.equal(accepts('pdf,pictures', 'Scan.PDF'), true);
  assert.equal(accepts('pdf,pictures', 'photo.heic'), true);
  assert.equal(accepts('pdf,pictures', 'notes.docx'), false);
  assert.equal(accepts('pdf', 'pdf'), false, 'no extension');
  assert.equal(accepts('pdf', 'report.pdf.exe'), false, 'the last one counts');
});

test('the words and the picker filter', () => {
  assert.equal(acceptText(null), 'any file');
  assert.equal(acceptText('pdf'), 'PDFs');
  assert.equal(acceptText('pdf,pictures'), 'PDFs or pictures');
  assert.equal(acceptText('documents,spreadsheets,zip'), 'Documents, spreadsheets or zip files');
  assert.equal(acceptAttr('pdf,zip'), '.pdf,.zip');
  assert.equal(acceptAttr(null), '');
});

test('checking what a request asks for', () => {
  assert.deepEqual(cleanRequest({ accept: ['zip', 'PDF', 'pdf'], max_mb: '25', note: ' Hi\r\nthere ' }, 100), { accept: 'pdf,zip', max_mb: 25, note: 'Hi\nthere' });
  assert.deepEqual(cleanRequest({ accept: [], max_mb: null, note: '' }, 100), { accept: null, max_mb: null, note: null });
  assert.deepEqual(cleanRequest({}, 100), {}, 'nothing said: nothing changed');
  for (const b of [{ accept: ['exe'] }, { max_mb: 0 }, { max_mb: 1.5 }, { max_mb: 101 }, { note: 'x'.repeat(501) }]) assert.throws(() => cleanRequest(b, 100), JSON.stringify(b));
});
