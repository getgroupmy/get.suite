import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabsOf, isTabbed, flattenTabs, cleanTitle, htmlWithTabTitles } from './doctabs.js';

const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = { type: 'doc', content: [
  { type: 'docTab', attrs: { id: 'a', title: 'Plan' }, content: [p('First')] },
  { type: 'docTab', attrs: { id: 'b', title: '' }, content: [p('Second')] },
] };

test('tabs: listed with their names (a default for an empty one)', () => {
  assert.deepEqual(tabsOf(doc), [{ id: 'a', title: 'Plan', index: 0 }, { id: 'b', title: 'Tab 2', index: 1 }]);
  assert.equal(isTabbed(doc), true);
  assert.deepEqual(tabsOf({ type: 'doc', content: [p('x')] }), []);
  assert.equal(cleanTitle('  Q3\n  plan '), 'Q3 plan');
  assert.equal(cleanTitle('x'.repeat(80)).length, 60);
});

test('tabs: laid end to end for downloads, each under its name from a new page', () => {
  assert.deepEqual(flattenTabs(doc).content, [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] }, p('First'),
    { type: 'pageBreak' }, { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Tab 2' }] }, p('Second'),
  ]);
  const plain = { type: 'doc', content: [p('x')] };
  assert.equal(flattenTabs(plain), plain, 'no tabs: unchanged');
  assert.equal(htmlWithTabTitles('<section class="doc-tab" data-tab-id="a" data-tab-title="Plan &amp; goals"><p>x</p></section>'),
    '<section class="doc-tab" data-tab-id="a" data-tab-title="Plan &amp; goals"><h1 class="tab-title">Plan &amp; goals</h1><p>x</p></section>');
});
