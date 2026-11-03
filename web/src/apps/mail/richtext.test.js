import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docToText, textToHtml, emailHtml } from './richtext.js';

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
