import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { attachmentsZip, safeName, uniqueNames } from '../src/mail/attzip.js';

test('attachments zip: every attachment, under safe and unique names, byte for byte', async () => {
  assert.equal(safeName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeName('Q3: "final" <v2>.xlsx'), 'Q3 final v2 .xlsx');
  assert.equal(safeName('', 'x'), 'x');
  assert.deepEqual(uniqueNames(['a.pdf', 'A.pdf', 'a.pdf', 'notes']), ['a.pdf', 'A (2).pdf', 'a (3).pdf', 'notes']);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const buf = await attachmentsZip([{ filename: 'photo.png', content: png }, { filename: 'photo.png', content: Buffer.from('two') }, { filename: null, content: Buffer.from('?') }]);
  const zip = await JSZip.loadAsync(buf);
  assert.deepEqual(Object.keys(zip.files), ['photo.png', 'photo (2).png', 'attachment-3']);
  assert.deepEqual(await zip.file('photo.png').async('nodebuffer'), png);
  assert.equal(await zip.file('photo (2).png').async('string'), 'two');
});
