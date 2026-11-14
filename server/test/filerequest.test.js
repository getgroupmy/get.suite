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

test('contents match the name: a renamed file is caught', async () => {
  const { looksLike } = await import('../src/filerequest.js');
  const B = (x) => Buffer.from(x, 'latin1');
  assert.equal(looksLike('a.pdf', B('%PDF-1.7\n')), true);
  assert.equal(looksLike('a.pdf', B('\r\n%PDF-1.4')), true, 'a little before the header is allowed');
  assert.equal(looksLike('a.pdf', B('MZ\x90\x00')), false);
  assert.equal(looksLike('a.png', B('\x89PNG\r\n\x1a\n')), true);
  assert.equal(looksLike('a.png', B('\xff\xd8\xff\xe0')), false);
  assert.equal(looksLike('a.webp', B('RIFF\0\0\0\0WEBPVP8 ')), true);
  assert.equal(looksLike('a.heic', B('\0\0\0\x18ftypheic')), true);
  assert.equal(looksLike('a.mp4', B('\0\0\0\x20ftypisom')), true);
  assert.equal(looksLike('a.xlsx', B('PK\x03\x04')), true);
  assert.equal(looksLike('a.xls', B('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')), true);
  assert.equal(looksLike('a.xls', B('PK\x03\x04')), false);
  assert.equal(looksLike('a.csv', B('a,b\n1,2')), true);
  assert.equal(looksLike('a.csv', B('a\0b')), false);
  assert.equal(looksLike('a.pdf', B('')), false, 'empty');
  assert.equal(looksLike('a.xyz', B('anything')), true, 'kinds not checked: as before');
});
