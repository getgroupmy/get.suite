// A page break: the document carries on from the top of a new page when printed, saved as PDF or
// downloaded for Word. On screen it's a dashed line across the page. Ctrl+Enter puts one in.
import { Node } from '@tiptap/core';

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }, { tag: 'hr[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': '', class: 'page-break', style: 'break-after: page; page-break-after: always;' }],
  addCommands() {
    return {
      setPageBreak: () => ({ chain }) => chain().insertContent({ type: this.name }).focus().run(),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
  },
});
