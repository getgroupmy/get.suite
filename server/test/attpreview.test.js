import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewMime, previewHeaders } from '../src/mail/preview.js';

test('email attachments: only kinds that cannot run script are shown in the browser', () => {
  assert.equal(previewMime('Invoice.PDF'), 'application/pdf');
  assert.equal(previewMime('photo.jpeg'), 'image/jpeg');
  assert.equal(previewMime('notes.txt'), 'text/plain');
  assert.equal(previewMime('call.mp3'), 'audio/mpeg');
  assert.equal(previewMime('clip.mp4'), 'video/mp4');
  for (const name of ['logo.svg', 'page.html', 'page.htm', 'data.xml', 'tool.exe', 'report.docx', 'archive.zip', 'noextension', '', null]) {
    assert.equal(previewMime(name), null, `${name} downloads`);
  }
});

test('email attachments: shown with nosniff, a sandboxed policy and the name kept', () => {
  const h = previewHeaders('text/plain', 'read me.txt');
  assert.equal(h['Content-Type'], 'text/plain; charset=utf-8');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.match(h['Content-Security-Policy'], /default-src 'none'.*sandbox/);
  assert.equal(h['Content-Disposition'], "inline; filename*=UTF-8''read%20me.txt");
  assert.equal(previewHeaders('image/png', 'a.png')['Content-Type'], 'image/png');
  assert.equal(previewHeaders('application/pdf', 'a.pdf')['Content-Security-Policy'], undefined, 'the PDF viewer needs the default policy');
});
