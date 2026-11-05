import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docToText, textToHtml, emailHtml, linkHref } from './richtext.js';

const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const p = (...content) => ({ type: 'paragraph', content });

test('plain-text version keeps structure', () => {
  const doc = { type: 'doc', content: [
    p(t('Hi '), t('Gina', [{ type: 'bold' }]), t(',')),
    p(),
    { type: 'bulletList', content: [
      { type: 'listItem', content: [p(t('500 bolts'))] },
      { type: 'listItem', content: [p(t('see '), t('our site', [{ type: 'link', attrs: { href: 'https://acme.com' } }]))] },
    ] },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(t('first'))] }, { type: 'listItem', content: [p(t('second'))] }] },
    { type: 'blockquote', content: [p(t('quoted line')), { type: 'blockquote', content: [p(t('deeper'))] }] },
  ] };
  assert.equal(docToText(doc), 'Hi Gina,\n\n- 500 bolts\n- see our site (https://acme.com)\n1. first\n2. second\n> quoted line\n> > deeper');
});

test('text to HTML escapes and keeps empty lines', () => {
  assert.equal(textToHtml('a <b>\n\nc & "d"\n'), '<p>a &lt;b&gt;</p><p></p><p>c &amp; &quot;d&quot;</p>');
});

test('email wrapper styles quotes', () => {
  assert.match(emailHtml('<blockquote><p>x</p></blockquote>'), /<blockquote style="margin/);
});

test('signature separator keeps its trailing space', () => {
  const doc = { type: 'doc', content: [p(t('Thanks')), p(t('--')), p(t('Olivia'))] };
  assert.equal(docToText(doc), 'Thanks\n-- \nOlivia');
});

test('pictures appear as [image: name] in the plain-text part', () => {
  const doc = { type: 'doc', content: [p(t('Logo:')), { type: 'image', attrs: { src: '/api/files/x/raw', alt: 'logo.png' } }] };
  assert.equal(docToText(doc), 'Logo:\n[image: logo.png]');
  assert.equal(emailHtml('<img src="cid:x" style="width:50%">').includes('<img src="cid:x" style="width:50%">'), true, 'picture markup is left alone');
});

test('tables: rows as "a | b" lines in plain text, inline cell styles in the email', () => {
  const p = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
  const cell = (type, t, attrs = {}) => ({ type, attrs, content: [p(t)] });
  const doc = { type: 'doc', content: [p('Order:'), { type: 'table', content: [
    { type: 'tableRow', content: [cell('tableHeader', 'Item'), cell('tableHeader', 'Price')] },
    { type: 'tableRow', content: [cell('tableCell', 'Desk'), cell('tableCell', '€200')] },
  ] }] };
  assert.equal(docToText(doc), 'Order:\nItem | Price\nDesk | €200');

  const html = emailHtml('<table style="min-width: 50px"><colgroup><col style="min-width: 25px"></colgroup><tbody>'
    + '<tr><th colspan="1" rowspan="1"><p>Item</p></th><th colspan="1" rowspan="1"><p>Price</p></th></tr>'
    + '<tr><td colspan="2" rowspan="1" style="x"><p>Total</p><p>incl. VAT</p></td></tr></tbody></table>');
  assert.doesNotMatch(html, /colgroup|min-width|rowspan="1"|style="x"/);
  assert.match(html, /<table style="border-collapse:collapse[^"]*">/);
  assert.match(html, /<th style="border:1px solid #ccc[^"]*font-weight:bold"><p style="margin:0">Item<\/p><\/th>/);
  assert.match(html, /<td colspan="2" style="border:1px solid #ccc[^"]*"><p style="margin:0">Total<\/p><p style="margin:0">incl\. VAT<\/p><\/td>/);
});

test('aligned paragraphs keep their alignment, also inside table cells', () => {
  const html = emailHtml('<p style="text-align: center">Title</p><table><tbody><tr><td><p style="text-align: right">€200</p><p>note</p></td></tr></tbody></table>');
  assert.match(html, /<p style="text-align: center">Title<\/p>/);
  assert.match(html, /<td style="[^"]*"><p style="margin:0; text-align: right">€200<\/p><p style="margin:0">note<\/p><\/td>/);
});

test('centred and right-aligned pictures are also wrapped in an aligned block (for Outlook)', () => {
  const html = emailHtml('<img src="cid:a" data-align="center" style="width:50%; display:block; margin-left:auto; margin-right:auto"><img src="cid:b" data-align="right"><img src="cid:c">');
  assert.match(html, /<div align="center" style="text-align:center"><img src="cid:a" data-align="center"[^>]*><\/div>/);
  assert.match(html, /<div align="right" style="text-align:right"><img src="cid:b" data-align="right"><\/div>/);
  assert.match(html, /<\/div><img src="cid:c"><\/div>$/, 'left pictures unchanged');
});

test('indented paragraphs are indented with spaces in the plain-text part', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [t('Steps:')] },
    { type: 'paragraph', attrs: { indent: 1 }, content: [t('first'), { type: 'hardBreak' }, t('more')] },
    { type: 'paragraph', attrs: { indent: 2 }, content: [t('detail')] },
  ] };
  assert.equal(docToText(doc), 'Steps:\n    first\n    more\n        detail');
});

test('link addresses: web addresses get https, email gets mailto, anything else is refused', () => {
  assert.equal(linkHref('web', 'example.com'), 'https://example.com/');
  assert.equal(linkHref('web', ' https://example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.equal(linkHref('web', 'http://intranet.acme.com'), 'http://intranet.acme.com/');
  assert.equal(linkHref('email', 'sales@acme.com'), 'mailto:sales@acme.com');
  assert.equal(linkHref('email', 'mailto:sales@acme.com'), 'mailto:sales@acme.com');
  for (const [k, v] of [['web', 'javascript:alert(1)'], ['web', 'ftp://x.com'], ['web', 'data:text/html,x'], ['web', 'not a url'], ['web', 'localhost'], ['web', ''], ['email', 'nobody'], ['email', 'a@b']]) {
    assert.equal(linkHref(k, v), null, `${k} ${v}`);
  }
});
