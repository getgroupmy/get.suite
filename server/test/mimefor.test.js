import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mimeFor, isInlineSafe } from '../src/util.js';

test('file types by name: OpenDocument, RTF, e-books, emails, calendars and contact cards have their own; none of them shown inline', () => {
  assert.equal(mimeFor('Plan.ODT'), 'application/vnd.oasis.opendocument.text');
  assert.equal(mimeFor('figures.ods'), 'application/vnd.oasis.opendocument.spreadsheet');
  assert.equal(mimeFor('deck.odp'), 'application/vnd.oasis.opendocument.presentation');
  assert.equal(mimeFor('letter.rtf'), 'application/rtf');
  assert.equal(mimeFor('book.epub'), 'application/epub+zip');
  assert.equal(mimeFor('mail.eml'), 'message/rfc822');
  assert.equal(mimeFor('trip.ics'), 'text/calendar');
  assert.equal(mimeFor('kim.vcf'), 'text/vcard');
  assert.equal(mimeFor('data.tsv'), 'text/tab-separated-values');
  assert.equal(mimeFor('backup.tar.gz'), 'application/gzip');
  assert.equal(mimeFor('no-extension'), 'application/octet-stream');
  for (const n of ['a.odt', 'a.rtf', 'a.epub', 'a.eml', 'a.ics', 'a.vcf', 'a.html', 'a.svg']) assert.equal(isInlineSafe(mimeFor(n)), false, n);
});
