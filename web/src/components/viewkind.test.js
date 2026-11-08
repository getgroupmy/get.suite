import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewKind, stepPreview } from './viewkind.js';

test('previewKind: by the file name, safe kinds only', () => {
  assert.equal(previewKind('Scan.JPG'), 'picture');
  assert.equal(previewKind('invoice.pdf'), 'pdf');
  assert.equal(previewKind('notes.txt'), 'text');
  assert.equal(previewKind('memo.mp3'), 'audio');
  assert.equal(previewKind('clip.webm'), 'video');
  assert.equal(previewKind('Report.DOCX'), 'office');
  assert.equal(previewKind('deck.pptx'), 'office');
  assert.equal(previewKind('Photos.ZIP'), 'zip');
  for (const n of ['logo.svg', 'page.html', 'report.doc', 'old.xls', 'a.7z', 'pdf', '', undefined]) assert.equal(previewKind(n), null);
});

test('stepPreview skips what cannot be shown and wraps round', () => {
  const atts = [{ filename: 'a.png' }, { filename: 'b.rar' }, { filename: 'c.pdf' }];
  assert.equal(stepPreview(atts, 0, 1), 2);
  assert.equal(stepPreview(atts, 2, 1), 0);
  assert.equal(stepPreview(atts, 0, -1), 2);
  assert.equal(stepPreview([{ filename: 'a.png' }, { filename: 'b.exe' }], 0, 1), 0);
});
