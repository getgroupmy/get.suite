// Fonts, text sizes and line spacing for Docs: the choices in the toolbar, and line spacing and the space
// before and after as attributes of paragraphs and headings (fonts and sizes are text styles, like colour).
import { Extension } from '@tiptap/core';

export const FONTS = [
  ['', 'Default'], ['Arial, Helvetica, sans-serif', 'Arial'], ['Georgia, serif', 'Georgia'], ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Verdana, Geneva, sans-serif', 'Verdana'], ['"Trebuchet MS", sans-serif', 'Trebuchet MS'], ['"Courier New", Courier, monospace', 'Courier New'],
];
export const SIZES = ['', '8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '18pt', '24pt', '30pt', '36pt'];
export const LINE_HEIGHTS = [['', 'Default'], ['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double']];
/** Space before / after a paragraph that the spacing menu adds (pt), as Word's and Google Docs' "Add space" do. */
export const PARA_SPACE = 12;
/** A paragraph's space before or after, in pt (0–72), from what a style says; only pt counts (as Docs, Word and Google Docs write it). */
export const ptOf = (v) => { const m = /^([\d.]+)pt$/.exec(String(v || '').trim()); const n = m ? Number(m[1]) : NaN; return n > 0 && n <= 72 ? Math.round(n * 10) / 10 : null; };
/** The spacing menu's choices for a paragraph: line spacing, then adding or removing space before and after. */
export const spacingChoices = (attrs = {}) => [
  ...LINE_HEIGHTS.map(([v, n]) => [v, v ? `↕ ${n}` : '↕ Spacing']),
  [attrs.spaceBefore ? 'before-off' : 'before-on', attrs.spaceBefore ? 'Remove space before paragraph' : 'Add space before paragraph'],
  [attrs.spaceAfter ? 'after-off' : 'after-on', attrs.spaceAfter ? 'Remove space after paragraph' : 'Add space after paragraph'],
];

const norm = (v) => String(v || '').replace(/['"\s]/g, '').toLowerCase();
/** The font menu's value for a text's font (fonts pasted in may be written differently). */
export const fontChoice = (family) => FONTS.find(([v]) => v && norm(v) === norm(family))?.[0] ?? (family ? 'other' : '');

export const LineHeight = Extension.create({
  name: 'lineHeight',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => { const v = el.style.lineHeight; return /^[\d.]+$/.test(v) ? v : null; },
          renderHTML: (attrs) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}),
        },
        spaceBefore: {
          default: null,
          parseHTML: (el) => ptOf(el.style.marginTop),
          renderHTML: (attrs) => (attrs.spaceBefore ? { style: `margin-top: ${attrs.spaceBefore}pt` } : {}),
        },
        spaceAfter: {
          default: null,
          parseHTML: (el) => ptOf(el.style.marginBottom),
          renderHTML: (attrs) => (attrs.spaceAfter ? { style: `margin-bottom: ${attrs.spaceAfter}pt` } : {}),
        },
      },
    }];
  },
  addCommands() {
    return {
      setLineHeight: (value) => ({ commands }) => ['paragraph', 'heading'].map((t) => commands.updateAttributes(t, { lineHeight: value || null })).some(Boolean),
      /** Space before or after the paragraphs the cursor is in ('before' | 'after'; pt, or null for none). */
      setParagraphSpace: (side, pt) => ({ commands }) => ['paragraph', 'heading'].map((t) => commands.updateAttributes(t, { [side === 'before' ? 'spaceBefore' : 'spaceAfter']: pt || null })).some(Boolean),
    };
  },
});
