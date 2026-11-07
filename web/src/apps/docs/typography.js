// Fonts, text sizes and line spacing for Docs: the choices in the toolbar, and line spacing as an
// attribute of paragraphs and headings (fonts and sizes are text styles, like colour).
import { Extension } from '@tiptap/core';

export const FONTS = [
  ['', 'Default'], ['Arial, Helvetica, sans-serif', 'Arial'], ['Georgia, serif', 'Georgia'], ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Verdana, Geneva, sans-serif', 'Verdana'], ['"Trebuchet MS", sans-serif', 'Trebuchet MS'], ['"Courier New", Courier, monospace', 'Courier New'],
];
export const SIZES = ['', '8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '18pt', '24pt', '30pt', '36pt'];
export const LINE_HEIGHTS = [['', 'Default'], ['1', 'Single'], ['1.15', '1.15'], ['1.5', '1.5'], ['2', 'Double']];

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
      },
    }];
  },
  addCommands() {
    return {
      setLineHeight: (value) => ({ commands }) => ['paragraph', 'heading'].map((t) => commands.updateAttributes(t, { lineHeight: value || null })).some(Boolean),
    };
  },
});
