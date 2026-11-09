import test from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BookmarkNode, bookmarksOf, bookmarkIdOf, bookmarkAnchor, isBookmarkId, newBookmarkId } from './bookmark.js';

const schema = getSchema([StarterKit, BookmarkNode]);

test('ids and anchors', () => {
  const id = newBookmarkId();
  assert.ok(isBookmarkId(id), id);
  assert.notEqual(newBookmarkId(), id);
  assert.equal(bookmarkAnchor('abc123de'), 'bm-abc123de');
  assert.equal(bookmarkIdOf('#bm-abc123de'), 'abc123de');
  assert.equal(bookmarkIdOf('bm-abc123de'), 'abc123de');
  assert.equal(bookmarkIdOf('#budget-costs'), null, 'a heading link is not a bookmark');
  assert.equal(bookmarkIdOf('#bm-AB'), null);
  assert.equal(isBookmarkId('x y'), false);
});

test('the bookmarks of a document, with the words after them (or before, at the end)', () => {
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'bookmark', attrs: { id: 'aaaaaa11' } }, { type: 'text', text: 'Payment terms apply.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'See the appendix' }, { type: 'bookmark', attrs: { id: 'bbbbbb22' } }] },
    { type: 'paragraph', content: [{ type: 'bookmark', attrs: { id: 'cccccc33' } }] },
  ] });
  assert.deepEqual(bookmarksOf(doc).map(({ id, text }) => [id, text]), [['aaaaaa11', 'Payment terms apply.'], ['bbbbbb22', '…See the appendix'], ['cccccc33', '']]);
  assert.equal(doc.nodeAt(bookmarksOf(doc)[1].pos).type.name, 'bookmark');
});

test('HTML: a marker with the anchor as its id, read back the same; bad ids are dropped', () => {
  const node = schema.nodes.bookmark.create({ id: 'k3x9q2ab' });
  const spec = BookmarkNode.config.renderHTML({ node, HTMLAttributes: { 'data-bookmark': 'k3x9q2ab' } });
  assert.equal(spec[1].id, 'bm-k3x9q2ab');
  const el = { getAttribute: (n) => (n === 'data-bookmark' ? 'k3x9q2ab' : null) };
  assert.equal(BookmarkNode.config.addAttributes().id.parseHTML(el), 'k3x9q2ab');
  assert.equal(BookmarkNode.config.addAttributes().id.parseHTML({ getAttribute: () => '"><script>' }), null);
});
