// Footnotes: a small number in the text, with its note listed at the end of the document (on screen,
// when printed or saved as PDF, in HTML and in Word files). The note lives on the marker itself, so it
// moves, copies and co-edits with it; numbers follow the order in the document.
import { Node } from '@tiptap/core';

export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    note: { default: '', parseHTML: (el) => el.getAttribute('data-note') || '', renderHTML: (a) => ({ 'data-note': a.note || '' }) },
  }),
  parseHTML: () => [{ tag: 'sup[data-footnote]' }],
  renderHTML: ({ HTMLAttributes }) => ['sup', { ...HTMLAttributes, 'data-footnote': '', class: 'footnote-ref', title: HTMLAttributes['data-note'] || 'Empty footnote' }],
  addCommands() {
    return {
      // Puts a marker at the cursor, then the cursor in its note (the list at the end shows it as #footnote-N),
      // once the editor has drawn it and taken focus back from the toolbar.
      insertFootnote: (note = '') => ({ commands, tr }) => {
        const ok = commands.insertContent({ type: this.name, attrs: { note } });
        if (ok && typeof document !== 'undefined') {
          // Within a chain the editor isn't updated yet: the transaction has the new document.
          const at = tr.selection.from;
          const list = footnotesOf(tr.doc);
          const n = list.findIndex((f) => f.pos === at - 1 || f.pos === at) + 1 || list.length; // the cursor ends after it (or on it)
          setTimeout(() => document.getElementById(`footnote-${n}`)?.focus(), 80);
        }
        return ok;
      },
    };
  },
});

/** The footnotes in a document, in order: [{ n, note, pos }] (pos: where the marker is). */
export function footnotesOf(doc) {
  const out = [];
  doc.descendants((node, pos) => { if (node.type.name === 'footnote') out.push({ n: out.length + 1, note: node.attrs.note || '', pos }); });
  return out;
}

/** The footnotes of a document's JSON, in order (for Word files): ['note', …]. */
export function footnotesOfJson(json) {
  const out = [];
  const walk = (n) => { if (n?.type === 'footnote') out.push(n.attrs?.note || ''); for (const c of n?.content || []) walk(c); };
  walk(json);
  return out;
}

/** HTML from the editor with numbered markers linking to a list of the notes at the end. */
export function htmlWithFootnotes(html) {
  const notes = [];
  const body = html.replace(/<sup([^>]*data-footnote[^>]*)>\s*<\/sup>/g, (m, attrs) => {
    const note = /data-note="([^"]*)"/.exec(attrs)?.[1] ?? '';
    notes.push(note);
    const k = notes.length;
    return `<sup class="footnote-ref" id="fnref-${k}"><a href="#fn-${k}">${k}</a></sup>`;
  });
  if (!notes.length) return html;
  // The notes are still escaped from the attribute, so they go in as they are.
  return `${body}<section class="footnotes"><hr><ol>${notes.map((t, i) => `<li id="fn-${i + 1}">${t} <a href="#fnref-${i + 1}" aria-label="Back to the text">↩</a></li>`).join('')}</ol></section>`;
}
