import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLink, linkTarget, linkLabel, slideTitle, dropLinksTo } from './slidelinks.js';

const deck = { slides: [
  { id: 's1', items: [{ id: 'a', type: 'text', role: 'title', text: 'Welcome' }, { id: 'b', type: 'shape', link: { slide: 's2' } }] },
  { id: 's2', items: [{ id: 'c', type: 'text', text: 'Prices\nand more' }] },
] };

test('links: web addresses and slides, cleaned', () => {
  assert.deepEqual(cleanLink({ url: 'acme.com/orders' }, ['s1']), { url: 'https://acme.com/orders' });
  assert.equal(cleanLink({ url: 'javascript:alert(1)' }, ['s1']), null);
  assert.deepEqual(cleanLink({ url: 'kim@acme.com' }, []), { url: 'mailto:kim@acme.com' });
  assert.deepEqual(cleanLink({ slide: 's2' }, ['s1', 's2']), { slide: 's2' });
  assert.equal(cleanLink({ slide: 'gone' }, ['s1']), null);
  assert.equal(cleanLink(null, []), null);
});

test('where a link goes, and how it reads', () => {
  assert.deepEqual(linkTarget(deck, { slide: 's2' }), { i: 1 });
  assert.deepEqual(linkTarget(deck, { url: 'https://acme.com' }), { url: 'https://acme.com/' });
  assert.equal(linkTarget(deck, { slide: 'nope' }), null);
  assert.equal(linkLabel(deck, { slide: 's2' }), 'Slide 2: Prices');
  assert.equal(linkLabel(deck, { url: 'https://www.acme.com/orders' }), 'acme.com/orders');
  assert.equal(slideTitle(deck.slides[0]), 'Welcome');
  assert.equal(dropLinksTo(deck, 's2').slides[0].items[1].link, undefined);
});
