// File chips in a document: typing "@" and part of a file's name offers files from Drive; the one picked
// goes in as a small pill (its icon and name) that opens the file. Kept as { id, name, kind, mime }, so
// downloads and search see the name even for readers who can't open the file.
import { Node } from '@tiptap/core';

/** The icon for a file chip, by what the file is. */
export function fileIcon(kind, mime = '', name = '') {
  if (kind === 'doc') return '📄';
  if (kind === 'sheet') return '📊';
  if (kind === 'slides') return '📽';
  if (kind === 'folder') return '📁';
  const m = String(mime).toLowerCase(), n = String(name).toLowerCase();
  if (m === 'application/pdf' || n.endsWith('.pdf')) return '📕';
  if (m.startsWith('image/')) return '🖼';
  return '📎';
}

/** Where a file opens: its editor, its folder, or Drive's preview. */
export function fileLink({ id, kind }) {
  const at = encodeURIComponent(String(id || ''));
  if (kind === 'doc') return `/docs/${at}`;
  if (kind === 'sheet') return `/sheets/${at}`;
  if (kind === 'slides') return `/slides/${at}`;
  if (kind === 'folder') return `/drive/folder/${at}`;
  return `/drive?preview=${at}`;
}

/** Files to offer for what's typed after "@" (search results): those whose name has it, best first, at most `max`. */
export function matchFiles(files, query, { exclude = null, max = 5 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  return (files || [])
    .filter((f) => f && f.id !== exclude && String(f.name || '').toLowerCase().includes(q))
    .map((f) => ({ f, at: String(f.name).toLowerCase().indexOf(q) }))
    .sort((a, b) => (a.at === 0 ? 0 : 1) - (b.at === 0 ? 0 : 1) || (b.f.updated_at || 0) - (a.f.updated_at || 0))
    .slice(0, max)
    .map(({ f }) => ({ kind: 'file', id: `file:${f.id}`, file: { id: f.id, name: f.name, kind: f.kind, mime: f.mime || '' } }));
}

export const FileChip = Node.create({
  name: 'filechip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    id: { default: null, parseHTML: (el) => el.getAttribute('data-filechip'), renderHTML: (a) => ({ 'data-filechip': a.id }) },
    name: { default: '', parseHTML: (el) => el.getAttribute('data-name') || el.textContent.replace(/^\S+\s/, ''), renderHTML: (a) => ({ 'data-name': a.name }) },
    kind: { default: 'file', parseHTML: (el) => el.getAttribute('data-kind') || 'file', renderHTML: (a) => ({ 'data-kind': a.kind }) },
    mime: { default: '', parseHTML: (el) => el.getAttribute('data-mime') || '', renderHTML: (a) => ({ 'data-mime': a.mime }) },
  }),
  parseHTML: () => [{ tag: 'a[data-filechip]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['a', { ...HTMLAttributes, class: 'doc-filechip', href: fileLink(node.attrs), title: `Open ${node.attrs.name}` },
    `${fileIcon(node.attrs.kind, node.attrs.mime, node.attrs.name)} ${node.attrs.name}`],
  renderText: ({ node }) => node.attrs.name,
  addCommands() {
    return {
      insertFileChip: (file) => ({ commands }) => commands.insertContent([{ type: this.name, attrs: { id: file.id, name: file.name, kind: file.kind || 'file', mime: file.mime || '' } }, { type: 'text', text: ' ' }]),
    };
  },
});
