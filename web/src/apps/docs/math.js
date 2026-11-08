// Equations in a document: an inline node holding LaTeX (\frac{a}{b}, x^2, \sqrt{2}, \sum_{i=1}^n),
// drawn with KaTeX. Typing $$…$$ makes one; clicking one edits it. Downloads keep the LaTeX:
// $…$ in Markdown, a Word equation in .docx.
import { Node, InputRule } from '@tiptap/core';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export const MAX_LATEX = 2000;
const OPTIONS = { strict: 'ignore', trust: false, maxSize: 20, maxExpand: 200 };

/** The equation as HTML (KaTeX), or KaTeX's own error display in its place; never throws. */
export function mathHtml(latex, display = false) {
  return katex.renderToString(String(latex || ''), { ...OPTIONS, throwOnError: false, displayMode: display });
}

/** What's wrong with it, for the editing box, or null when KaTeX can read it. */
export function mathError(latex) {
  try { katex.renderToString(String(latex || ''), { ...OPTIONS, throwOnError: true }); return null; } catch (e) { return String(e.message || e).replace(/^KaTeX parse error: /, ''); }
}

export const MathInline = Node.create({
  name: 'math',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    latex: { default: '', parseHTML: (el) => el.getAttribute('data-latex') || '', renderHTML: (a) => ({ 'data-latex': a.latex }) },
  }),
  parseHTML: () => [{ tag: 'span[data-math]' }],
  // In HTML downloads and copies: the LaTeX between dollars (KaTeX draws it in the editor).
  renderHTML: ({ node, HTMLAttributes }) => ['span', { ...HTMLAttributes, 'data-math': '', class: 'doc-math' }, `$${node.attrs.latex}$`],
  renderText: ({ node }) => node.attrs.latex,
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.className = 'doc-math';
      dom.setAttribute('data-math', '');
      const show = (latex) => {
        dom.innerHTML = mathHtml(latex);
        dom.setAttribute('aria-label', `Equation: ${latex}`);
      };
      dom.setAttribute('role', 'button');
      dom.title = 'Click to change the equation';
      show(node.attrs.latex);
      return {
        dom,
        update: (next) => { if (next.type.name !== 'math') return false; show(next.attrs.latex); return true; },
        ignoreMutation: () => true,
      };
    };
  },
  addCommands() {
    return { insertMath: (latex) => ({ commands }) => commands.insertContent({ type: this.name, attrs: { latex: String(latex).slice(0, MAX_LATEX) } }) };
  },
  addInputRules() {
    return [new InputRule({
      find: /\$\$([^$\n]+)\$\$$/,
      handler: ({ state, range, match }) => {
        const latex = match[1].trim();
        if (!latex) return null;
        state.tr.replaceWith(range.from, range.to, this.type.create({ latex: latex.slice(0, MAX_LATEX) }));
      },
    })];
  },
});
