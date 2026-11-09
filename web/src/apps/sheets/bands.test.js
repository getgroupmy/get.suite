import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandFill, bandStyle, cleanBand, overlaps, adjustBands, textOn, BAND_STYLES } from './bands.js';
import { applyStructure } from './structure.js';

const band = { id: 'b1', range: 'A1:C6', header: true, footer: true, head: '#4a86e8', odd: '#ffffff', even: '#e8f0fe', foot: '#c6dafc' };

test('heading, stripes and footer', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((r) => bandFill([band], 1, r)?.kind), ['head', 'odd', 'even', 'odd', 'even', 'foot']);
  assert.equal(bandFill([band], 3, 1), null, 'outside the columns');
  assert.equal(bandFill([band], 0, 6), null, 'below');
  assert.deepEqual([0, 1, 2].map((r) => bandFill([{ ...band, header: false, footer: false }], 0, r).kind), ['odd', 'even', 'odd']);
});

test('the style: own fill wins; text readable on the heading', () => {
  assert.deepEqual(bandStyle([band], 0, 0), { background: '#4a86e8', color: '#ffffff', fontWeight: 700 });
  assert.deepEqual(bandStyle([band], 0, 2), { background: '#e8f0fe', color: '#202124' });
  assert.equal(bandStyle([band], 0, 2, { fill: '#ff0000' }), undefined);
  assert.deepEqual(bandStyle([band], 0, 2, { color: '#00ff00' }), { background: '#e8f0fe' });
  assert.equal(bandStyle([], 0, 0), undefined);
  assert.equal(textOn('#5f6368'), '#ffffff');
  assert.equal(textOn('#feefe3'), '#202124');
});

test('cleaning: bad colours fall back, ranges are tidied', () => {
  const b = cleanBand({ range: '$a1:$d9', head: 'red', odd: '#FFFFFF' });
  assert.equal(b.range, 'A1:D9');
  assert.equal(b.head, BAND_STYLES[0].head);
  assert.equal(b.odd, '#ffffff');
  assert.equal(b.header, true);
  assert.equal(b.footer, false);
  assert.equal(cleanBand({ range: 'nope' }), null);
});

test('overlaps', () => {
  assert.equal(overlaps('A1:C6', 'C6:D9'), true);
  assert.equal(overlaps('A1:C6', 'D1:D9'), false);
});

test('rows inserted inside grow the band; deleting all of it removes it', () => {
  assert.deepEqual(adjustBands([band], { axis: 'row', at: 2, count: 2 }).map((b) => b.range), ['A1:C8']);
  assert.equal(adjustBands([band], { axis: 'row', at: 0, count: -6 }), undefined);
  const out = applyStructure({ cells: {}, bands: [band] }, { axis: 'col', at: 0, count: 1 });
  assert.equal(out.bands[0].range, 'B1:D6');
});
