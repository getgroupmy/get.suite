// People in a document: typing "@" and a name puts in a chip for a colleague; they're notified
// (or, if they can't open the document, its owner is offered to share it with them).
import { Node } from '@tiptap/core';

export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    id: { default: null, parseHTML: (el) => el.getAttribute('data-mention'), renderHTML: (a) => ({ 'data-mention': a.id }) },
    name: { default: '', parseHTML: (el) => el.getAttribute('data-name') || el.textContent.replace(/^@/, ''), renderHTML: (a) => ({ 'data-name': a.name }) },
    email: { default: '', parseHTML: (el) => el.getAttribute('data-email') || '', renderHTML: (a) => ({ 'data-email': a.email }) },
  }),
  parseHTML: () => [{ tag: 'span[data-mention]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', { ...HTMLAttributes, class: 'doc-mention', title: node.attrs.email }, `@${node.attrs.name}`],
  renderText: ({ node }) => `@${node.attrs.name}`,
});

/** The "@word" being typed just before the cursor in a text block: { from, query } or null. */
export function mentionQuery(textBefore, cursor) {
  const m = /(^|[\s(])@([\p{L}\p{N}.'-]{0,30})$/u.exec(textBefore);
  return m ? { from: cursor - m[2].length - 1, query: m[2] } : null;
}

/** People matching what's typed (name or address), at most six, names starting with it first. */
export function matchPeople(people, query) {
  const q = query.toLowerCase();
  return people.filter((p) => `${p.name} ${p.username}`.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, 6);
}
