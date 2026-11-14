import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partsOf, kindOf, PART_RE } from '../src/mail/attachlist.js';

test('attachments from a body structure: attachments and named inline files, not the text or its pictures', () => {
  const tree = {
    type: 'multipart/mixed', childNodes: [
      { type: 'multipart/alternative', childNodes: [
        { part: '1.1', type: 'text/plain', size: 100 },
        { type: 'multipart/related', childNodes: [
          { part: '1.2.1', type: 'text/html', size: 300 },
          { part: '1.2.2', type: 'image/png', id: '<logo@x>', disposition: 'inline', dispositionParameters: { filename: 'logo.png' }, encoding: 'base64', size: 400 },
        ] },
      ] },
      { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'Invoice 42.pdf' }, encoding: 'base64', size: 4000 },
      { part: '3', type: 'application/octet-stream', parameters: { name: 'Budget.xlsx' }, encoding: 'base64', size: 800 },
      { part: '4', type: 'image/jpeg', disposition: 'inline', dispositionParameters: { filename: 'site photo.jpg' }, encoding: 'base64', size: 1200 },
      { part: '5', type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' }, encoding: '7bit', size: 50 },
      { part: '6', type: 'message/rfc822', size: 900 }, // a forwarded message shown in the text
      { part: '7', type: 'message/rfc822', disposition: 'attachment', size: 700 },
    ],
  };
  assert.deepEqual(partsOf(tree), [
    { part: '2', filename: 'Invoice 42.pdf', type: 'application/pdf', size: 3000, kind: 'pdf' },
    { part: '3', filename: 'Budget.xlsx', type: 'application/octet-stream', size: 600, kind: 'spreadsheet' },
    { part: '4', filename: 'site photo.jpg', type: 'image/jpeg', size: 900, kind: 'image' },
    { part: '5', filename: 'notes.txt', type: 'text/plain', size: 50, kind: 'document' },
    { part: '7', filename: 'message.eml', type: 'message/rfc822', size: 700, kind: 'other' },
  ]);
  assert.deepEqual(partsOf({ part: '1', type: 'text/plain', size: 10 }), [], 'a plain message');
  assert.deepEqual(partsOf(null), []);
  // A message that is just one file.
  assert.equal(partsOf({ type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' }, size: 4 })[0].part, '1');
});

test('kinds: by extension first, then type', () => {
  assert.equal(kindOf('Q3.PPTX', 'application/octet-stream'), 'presentation');
  assert.equal(kindOf('scan', 'image/heic'), 'image');
  assert.equal(kindOf('data.csv', 'text/plain'), 'spreadsheet');
  assert.equal(kindOf('backup.zip', ''), 'archive');
  assert.equal(kindOf('thing.bin', 'application/octet-stream'), 'other');
  assert.equal(kindOf('', 'application/pdf'), 'pdf');
});

test('part numbers: only IMAP ones', () => {
  for (const ok of ['1', '2', '1.2', '1.3.2']) assert.match(ok, PART_RE);
  for (const no of ['', '0x1', '1.', '.1', '1..2', 'HEADER', '1;2', '1.2.TEXT']) assert.doesNotMatch(no, PART_RE);
});
