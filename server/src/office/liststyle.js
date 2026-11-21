// List styles (Docs): a numbered list counts 1. 2. 3., a. b. c., A. B. C., i. ii. iii. or I. II. III.; a bulleted list
// shows ●, ○, ■, –, ➢ or ✓. Kept on the list (everyone editing sees it), in Word downloads and when Word files open.
// A copy of web/src/apps/docs/liststyle.js (keep them alike): Word downloads and Word files opened.
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

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
const roman = (n) => { let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; };
const letters = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s; return s; }; // (a … z, aa, ab …, as browsers count)
/** A numbered list's label for number `n` in its style ("iv.", "C.", "12."), as the editor shows it. */
export function listLabel(style, n) {
  const k = Math.max(1, Math.round(Number(n) || 1));
  const t = { 'lower-alpha': letters(k), 'upper-alpha': letters(k).toUpperCase(), 'lower-roman': roman(k), 'upper-roman': roman(k).toUpperCase() }[style] ?? String(k);
  return `${t}.`;
}
/** A bulleted list's bullet character (● for the usual one). */
export const bulletChar = (bullet) => (BULLETS.find((b) => b[0] === bullet) || BULLETS[0])[3];

const ROMAN_VALUE = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const romanValue = (s) => { let t = 0; const l = s.toLowerCase(); for (let i = 0; i < l.length; i++) { const v = ROMAN_VALUE[l[i]], w = ROMAN_VALUE[l[i + 1]] || 0; t += v < w ? -v : v; } return t; };
/**
 * A list label as other programs write it before an item ("3.", "iv.", "b)", "•", "✓"): { kind: 'orderedList', style, n }
 * or { kind: 'bulletList', bullet }, or null. `open` is the style of a numbered list being read, if any. A lone letter is a
 * letter (C. after B.), except i. starting a roman list, or v., x. … carrying on an open roman one.
 */
export function readLabel(label, open = null) {
  const t = String(label || '').trim();
  let m = /^(\d{1,4})[.)]$/.exec(t);
  if (m) return { kind: 'orderedList', style: null, n: Number(m[1]) };
  m = /^([ivxlcdm]+|[IVXLCDM]+)[.)]$/.exec(t);
  const alphaOpen = open === 'lower-alpha' || open === 'upper-alpha', romanOpen = open === 'lower-roman' || open === 'upper-roman';
  if (m && (m[1].length > 1 ? !alphaOpen || m[1].length > 2 : romanOpen || (/^i$/i.test(m[1]) && !alphaOpen)) && romanValue(m[1]) > 0) return { kind: 'orderedList', style: m[1] === m[1].toLowerCase() ? 'lower-roman' : 'upper-roman', n: romanValue(m[1]) };
  m = /^([a-z]{1,2}|[A-Z]{1,2})[.)]$/.exec(t);
  if (m) { const s = m[1].toLowerCase(); return { kind: 'orderedList', style: m[1] === s ? 'lower-alpha' : 'upper-alpha', n: [...s].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 96, 0) }; }
  if (/^[•●▪■◦○o·–\-➢➤✓✔]$/.test(t) || FONT_BULLETS[t]) return { kind: 'bulletList', bullet: bulletOfWord(t === '•' || t === '·' ? '●' : t === '○' ? '○' : t) };
  return null;
}

/** Most levels a slide list goes in (Tab at the start of a line: a point under the one above). */
export const SLIDE_LEVELS = 4;
/**
 * A slide text box as a list (its `list`: a bullet or numbering above): each line with its level (tabs at its start, up
 * to SLIDE_LEVELS - 1), its words, and its marker ("ii.", "✓"; none on an empty line). Numbers count at each level, starting
 * again under a new point above; a point under another shows – (bullets) or its level's own count (numbers).
 */
export function slideListLines(text, list) {
  const isNum = NUMBERINGS.some(([k]) => k === list), isBullet = BULLETS.some(([k]) => k === list);
  const counts = [];
  return String(text || '').split('\n').map((raw) => {
    const level = Math.min(SLIDE_LEVELS - 1, /^\t*/.exec(raw)[0].length);
    const t = raw.slice(/^\t*/.exec(raw)[0].length);
    if (!t.trim() || (!isNum && !isBullet)) return { text: t, level, marker: null };
    counts.length = level + 1;
    counts[level] = (counts[level] || 0) + 1;
    return { text: t, level, marker: isNum ? listLabel(list, counts[level]) : level ? '–' : bulletChar(list) };
  });
}
