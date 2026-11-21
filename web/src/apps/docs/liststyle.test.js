import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListStyle, cleanNumbering, cleanBullet, numberingOfWord, bulletOfWord } from './liststyle.js';

test('kept values: the usual ones are none', () => {
  assert.equal(cleanNumbering('lower-roman'), 'lower-roman');
  assert.equal(cleanNumbering('decimal'), null);
  assert.equal(cleanNumbering('url(evil)'), null);
  assert.equal(cleanBullet('check'), 'check');
  assert.equal(cleanBullet('disc'), null);
  assert.equal(cleanBullet('"x"'), null);
});

test('from Word: numbering formats and bullet characters (Word’s own Wingdings ones too)', () => {
  assert.equal(numberingOfWord('lowerLetter'), 'lower-alpha');
  assert.equal(numberingOfWord('upperRoman'), 'upper-roman');
  assert.equal(numberingOfWord('decimal'), null);
  assert.equal(bulletOfWord('○'), 'circle');
  assert.equal(bulletOfWord('o'), 'circle', 'Word’s hollow bullet is an "o" in Courier New');
  assert.equal(bulletOfWord('▪'), 'square');
  assert.equal(bulletOfWord('✓'), 'check');
  assert.equal(bulletOfWord('•'), null);
  assert.equal(bulletOfWord('\uF02D'), 'dash', 'LibreOffice’s dash: the Symbol font’s minus');
  assert.equal(bulletOfWord('\uF0FC'), 'check', 'Word’s Wingdings tick');
  assert.equal(bulletOfWord('\uF0B7'), null, 'Word’s usual Symbol bullet: the usual one');
});

test('read from HTML (data-, an <ol type> as browsers and other programs write it, a list-style) and written back', () => {
  const [ol, ul] = ListStyle.config.addGlobalAttributes();
  const el = (attrs, style = {}) => ({ getAttribute: (k) => attrs[k] ?? null, style });
  const num = ol.attributes.listStyle, bul = ul.attributes.bullet;
  assert.equal(num.parseHTML(el({ type: 'i' })), 'lower-roman');
  assert.equal(num.parseHTML(el({ 'data-list-style': 'upper-alpha' })), 'upper-alpha');
  assert.equal(num.parseHTML(el({}, { listStyleType: 'lower-alpha' })), 'lower-alpha');
  assert.equal(num.parseHTML(el({ type: '1' })), null);
  assert.deepEqual(num.renderHTML({ listStyle: 'lower-roman' }), { 'data-list-style': 'lower-roman', type: 'i', style: 'list-style-type: lower-roman' });
  assert.deepEqual(num.renderHTML({ listStyle: null }), {});
  assert.equal(bul.parseHTML(el({ 'data-bullet': 'dash' })), 'dash');
  assert.equal(bul.parseHTML(el({}, { listStyleType: 'square' })), 'square');
  assert.deepEqual(bul.renderHTML({ bullet: 'dash' }), { 'data-bullet': 'dash', style: 'list-style-type: "– "' });
});

test('labels: numbers in each style, as browsers count them; bullets', async () => {
  const { listLabel, bulletChar } = await import('./liststyle.js');
  assert.deepEqual([1, 4, 9, 14, 40, 1999].map((n) => listLabel('lower-roman', n)), ['i.', 'iv.', 'ix.', 'xiv.', 'xl.', 'mcmxcix.']);
  assert.deepEqual([1, 26, 27, 52, 53].map((n) => listLabel('lower-alpha', n)), ['a.', 'z.', 'aa.', 'az.', 'ba.']);
  assert.equal(listLabel('upper-roman', 12), 'XII.');
  assert.equal(listLabel('upper-alpha', 3), 'C.');
  assert.equal(listLabel(null, 7), '7.');
  assert.equal(bulletChar('check'), '✓');
  assert.equal(bulletChar(null), '●');
});

test('reading labels other programs write: kind, style and number', async () => {
  const { readLabel } = await import('./liststyle.js');
  assert.deepEqual(readLabel('3.'), { kind: 'orderedList', style: null, n: 3 });
  assert.deepEqual(readLabel('iv.'), { kind: 'orderedList', style: 'lower-roman', n: 4 });
  assert.deepEqual(readLabel('XII)'), { kind: 'orderedList', style: 'upper-roman', n: 12 });
  assert.deepEqual(readLabel('b)'), { kind: 'orderedList', style: 'lower-alpha', n: 2 });
  assert.deepEqual(readLabel('i.'), { kind: 'orderedList', style: 'lower-roman', n: 1 }, 'a lone i starts a roman list');
  assert.deepEqual(readLabel('i.', 'lower-alpha'), { kind: 'orderedList', style: 'lower-alpha', n: 9 }, '…and carries on a lettered one');
  assert.deepEqual(readLabel('C.'), { kind: 'orderedList', style: 'upper-alpha', n: 3 }, 'a lone C: a letter (a lettered list starting at C)');
  assert.deepEqual(readLabel('v.', 'lower-roman'), { kind: 'orderedList', style: 'lower-roman', n: 5 }, 'v. carrying on i. ii. iii. iv.');
  assert.deepEqual(readLabel('v.'), { kind: 'orderedList', style: 'lower-alpha', n: 22 });
  assert.deepEqual(readLabel('ii.', 'lower-alpha'), { kind: 'orderedList', style: 'lower-alpha', n: 243 }, '(two letters carrying on a lettered list: ii, as browsers count past z: aa is 27)');
  assert.deepEqual(readLabel('xiv.'), { kind: 'orderedList', style: 'lower-roman', n: 14 });
  assert.deepEqual(readLabel('•'), { kind: 'bulletList', bullet: null });
  assert.deepEqual(readLabel('✓'), { kind: 'bulletList', bullet: 'check' });
  assert.deepEqual(readLabel('–'), { kind: 'bulletList', bullet: 'dash' });
  assert.equal(readLabel('Note:'), null);
});
