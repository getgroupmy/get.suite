import { test } from 'node:test';
import assert from 'node:assert/strict';
import { picturesOf, pdfsOf } from './qrscan.js';

test('the pictures looked at: inline data: pictures and attached pictures (not other files, not huge ones), up to 12', () => {
  const html = '<p><img alt="a" src="data:image/png;base64,AAA="></p><img src=\'data:image/jpeg;base64,BBB=\'><img src="https://x.example/p.png"><img src="data:image/svg+xml;base64,CCC=">';
  const atts = [{ index: 0, contentType: 'image/png', size: 1000 }, { index: 1, contentType: 'application/pdf', size: 10 }, { index: 2, contentType: 'image/jpeg', size: 20 * 1024 * 1024 }, { index: 3, contentType: 'IMAGE/GIF', size: 5 }];
  assert.deepEqual(picturesOf(html, atts, (a) => `att:${a.index}`), ['data:image/png;base64,AAA=', 'data:image/jpeg;base64,BBB=', 'att:0', 'att:3']);
  const many = Array.from({ length: 20 }, (_, i) => ({ index: i, contentType: 'image/png', size: 1 }));
  assert.equal(picturesOf('', many, (a) => a.index).length, 12);
  assert.deepEqual(picturesOf(null, null, () => ''), []);
});

test('the PDFs looked at: attached PDFs (by type or name) up to 10 MB, at most 3', () => {
  const atts = [{ index: 0, contentType: 'application/pdf', size: 1 }, { index: 1, contentType: 'application/octet-stream', filename: 'Invoice.PDF', size: 1 },
    { index: 2, contentType: 'application/pdf', size: 11 * 1024 * 1024 }, { index: 3, contentType: 'image/png', size: 1 }, { index: 4, contentType: 'application/pdf', size: 1 }, { index: 5, contentType: 'application/pdf', size: 1 }];
  assert.deepEqual(pdfsOf(atts, (a) => a.index), [0, 1, 4]);
  assert.deepEqual(pdfsOf(null, () => 0), []);
});
