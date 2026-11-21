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
