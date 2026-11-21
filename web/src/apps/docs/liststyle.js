// List styles (Docs): a numbered list counts 1. 2. 3., a. b. c., A. B. C., i. ii. iii. or I. II. III.; a bulleted list
// shows ●, ○, ■, –, ➢ or ✓. Kept on the list (everyone editing sees it), in Word downloads and when Word files open.
// server/src/office/liststyle.js is a copy (keep them alike).
import { Extension } from '@tiptap/core';

/** Numbering: [value, label, the HTML <ol type>, Word's w:numFmt]. */
export const NUMBERINGS = [
  ['decimal', '1. 2. 3.', '1', 'decimal'],
  ['lower-alpha', 'a. b. c.', 'a', 'lowerLetter'],
  ['upper-alpha', 'A. B. C.', 'A', 'upperLetter'],
  ['lower-roman', 'i. ii. iii.', 'i', 'lowerRoman'],
  ['upper-roman', 'I. II. III.', 'I', 'upperRoman'],
];
/** Bullets: [value, label, CSS list-style-type, the character Word shows]. */
export const BULLETS = [
  ['disc', '● Filled circle', 'disc', '●'],
  ['circle', '○ Hollow circle', 'circle', '○'],
  ['square', '■ Square', 'square', '■'],
  ['dash', '– Dash', '"– "', '–'],
  ['arrow', '➢ Arrow', '"➢ "', '➢'],
  ['check', '✓ Tick', '"✓ "', '✓'],
];

/** A numbering style kept (null: the usual 1. 2. 3.). */
export const cleanNumbering = (v) => (NUMBERINGS.some(([k]) => k === v) && v !== 'decimal' ? v : null);
/** A bullet kept (null: the usual ●). */
export const cleanBullet = (v) => (BULLETS.some(([k]) => k === v) && v !== 'disc' ? v : null);
const TYPE_OF = Object.fromEntries(NUMBERINGS.map(([k, , t]) => [t, k]));
/** From Word: a w:numFmt as a numbering style; a bullet level's text as a bullet. */
export const numberingOfWord = (fmt) => cleanNumbering(NUMBERINGS.find((n) => n[3] === fmt)?.[0]);
// Symbol and Wingdings bullets as Word and LibreOffice write them (characters of those fonts, in the private-use area).
const FONT_BULLETS = { '\uF0B7': 'disc', '\uF02D': 'dash', '\uF0A7': 'square', '\uF0D8': 'arrow', '\uF0FC': 'check', o: 'circle', '▪': 'square', '◦': 'circle', '-': 'dash', '➤': 'arrow', '✔': 'check' };
export const bulletOfWord = (text) => { const t = String(text || '').trim(); return cleanBullet(FONT_BULLETS[t] || BULLETS.find((b) => b[3] === t)?.[0]); };

export const ListStyle = Extension.create({
  name: 'listStyle',
  addGlobalAttributes() {
    return [{
      types: ['orderedList'],
      attributes: {
        listStyle: {
          default: null,
          parseHTML: (el) => cleanNumbering(el.getAttribute('data-list-style') || TYPE_OF[el.getAttribute('type')] || el.style?.listStyleType),
          renderHTML: (a) => (a.listStyle ? { 'data-list-style': a.listStyle, type: NUMBERINGS.find((n) => n[0] === a.listStyle)[2], style: `list-style-type: ${a.listStyle}` } : {}), // (the style too: a stylesheet's list-style wins over type)
        },
      },
    }, {
      types: ['bulletList'],
      attributes: {
        bullet: {
          default: null,
          parseHTML: (el) => cleanBullet(el.getAttribute('data-bullet') || el.style?.listStyleType),
          renderHTML: (a) => (a.bullet ? { 'data-bullet': a.bullet, style: `list-style-type: ${BULLETS.find((b) => b[0] === a.bullet)[2]}` } : {}),
        },
      },
    }];
  },
});
