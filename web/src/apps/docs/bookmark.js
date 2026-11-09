// Bookmarks (Docs): a small marker anywhere in the text that a link can point to. The document's
// address ending in #bm-<id> opens it there. Word downloads keep them as Word bookmarks (and links to
// them as links inside the document); Word files bring theirs in.
import { Node } from '@tiptap/core';

export const isBookmarkId = (s) => /^[a-z0-9]{6,16}$/.test(String(s || ''));
export const newBookmarkId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
/** The part of a link after # for a bookmark: "bm-k3x9q2ab". */
export const bookmarkAnchor = (id) => `bm-${id}`;

/** The bookmark a link's #… names, or null: "#bm-k3x9q2ab" → "k3x9q2ab". */
export function bookmarkIdOf(hash) {
  const m = /^#?bm-([a-z0-9]{6,16})$/.exec(decodeURIComponent(String(hash || '')));
  return m ? m[1] : null;
}

/** The document's bookmarks in order: { id, pos, text } with a few words of what follows each (or precedes it, at a paragraph's end). */
export function bookmarksOf(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'bookmark') return true;
    const $p = doc.resolve(pos);
    const para = $p.parent;
    const off = $p.parentOffset;
    const after = para.textBetween(Math.min(para.content.size, off + 1), para.content.size, ' ', ' ').trim();
    const before = para.textBetween(0, off, ' ', ' ').trim();
    const text = after ? after.slice(0, 60) : before ? `…${before.slice(-60)}` : '';
    out.push({ id: node.attrs.id, pos, text });
    return false;
  });
  return out;
}

export const BookmarkNode = Node.create({
  name: 'bookmark',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    id: { default: null, parseHTML: (el) => (isBookmarkId(el.getAttribute('data-bookmark')) ? el.getAttribute('data-bookmark') : null), renderHTML: (a) => ({ 'data-bookmark': a.id }) },
  }),
  parseHTML: () => [{ tag: 'span[data-bookmark]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', { ...HTMLAttributes, id: bookmarkAnchor(node.attrs.id), class: 'doc-bookmark', title: 'Bookmark', 'aria-label': 'Bookmark' }],
  renderText: () => '',
  addCommands() {
    return {
      /** A bookmark at the cursor (a new id, or `id`); the id is in the transaction's meta 'bookmark'. */
      insertBookmark: (id = newBookmarkId()) => ({ tr, dispatch }) => {
        if (!isBookmarkId(id)) return false;
        if (dispatch) { tr.insert(tr.selection.from, this.type.create({ id })); tr.setMeta('bookmark', id); }
        return true;
      },
    };
  },
});
