import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BookmarkNode } from './bookmark.js';
import { placesOf, cleanHref, describeHref } from './linkplaces.js';

const schema = getSchema([StarterKit, BookmarkNode]);
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text) => ({ type: 'text', text });

test('places: headings and bookmarks in document order, with their anchors', () => {
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    h(1, 'Budget & Costs'), p(t('Intro'), { type: 'bookmark', attrs: { id: 'aaaaaa11' } }), h(2, 'Notes'), h(2, 'Notes'), p({ type: 'bookmark', attrs: { id: 'bbbbbb22' } }, t('Appendix text')),
  ] });
  assert.deepEqual(placesOf(doc), [
    { kind: 'heading', level: 1, text: 'Budget & Costs', href: '#budget-costs' },
    { kind: 'bookmark', text: '…Intro', href: '#bm-aaaaaa11' },
    { kind: 'heading', level: 2, text: 'Notes', href: '#notes' },
    { kind: 'heading', level: 2, text: 'Notes', href: '#notes-2' },
    { kind: 'bookmark', text: 'Appendix text', href: '#bm-bbbbbb22' },
  ]);
});

test('typed addresses', () => {
  assert.deepEqual(cleanHref('https://example.com/a?b=1'), { href: 'https://example.com/a?b=1' });
  assert.deepEqual(cleanHref(' example.com/path '), { href: 'https://example.com/path' });
  assert.deepEqual(cleanHref('www.acme.co.uk'), { href: 'https://www.acme.co.uk' });
  assert.deepEqual(cleanHref('kim@acme.com'), { href: 'mailto:kim@acme.com' });
  assert.deepEqual(cleanHref('mailto:kim@acme.com'), { href: 'mailto:kim@acme.com' });
  assert.deepEqual(cleanHref('/docs/abc'), { href: '/docs/abc' });
  assert.deepEqual(cleanHref('#bm-aaaaaa11'), { href: '#bm-aaaaaa11' });
  assert.ok(cleanHref('').error);
  assert.ok(cleanHref('javascript:alert(1)').error, 'no scripts');
  assert.ok(cleanHref('two words').error);
  assert.ok(cleanHref('hello').error);
  assert.ok(cleanHref('#').error);
});

test('describing where a link goes', () => {
  const places = [{ kind: 'heading', text: 'Costs', href: '#costs' }, { kind: 'bookmark', text: 'Pay in 30 days', href: '#bm-aaaaaa11' }];
  assert.equal(describeHref('#costs', places), 'Heading: Costs');
  assert.equal(describeHref('#bm-aaaaaa11', places), 'Bookmark: Pay in 30 days');
  assert.equal(describeHref('mailto:kim@acme.com', places), 'kim@acme.com');
  assert.equal(describeHref('#gone', places), '#gone');
});
