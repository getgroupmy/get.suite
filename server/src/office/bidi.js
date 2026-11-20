// Right-to-left text for PDFs (drawn left to right, glyph by glyph): Arabic letters joined (each in its isolated,
// initial, medial or final form, from Unicode's presentation forms, and lam-alef as one), and a line's characters put in
// the order they're seen: right-to-left runs reversed, numbers and Latin words inside them kept as written, brackets
// mirrored, and in a paragraph that starts right to left the runs' order turned too. A simplified Unicode bidi
// algorithm (one level of embedding), enough for Hebrew and Arabic text with numbers and the odd Latin word.

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ฀-๿஀-௿ऀ-ॿ぀-ヿ㐀-鿿가-힯]/;
const DIGIT = /[0-9٠-٩۰-۹]/;
export const hasRtl = (s) => RTL.test(String(s || ''));
/** Is a paragraph right to left (its first letter with a direction is)? */
export const isRtlText = (s) => { for (const ch of String(s || '')) { if (RTL.test(ch)) return true; if (LTR.test(ch)) return false; } return false; };

// Arabic letters: [isolated, final, initial, medial] presentation forms (Unicode block FE70–FEFF); two forms: joins on
// the right only (alef, dal, ra, waw…)
const FORMS = {
  0x0621: [0xfe80], 0x0622: [0xfe81, 0xfe82], 0x0623: [0xfe83, 0xfe84], 0x0624: [0xfe85, 0xfe86], 0x0625: [0xfe87, 0xfe88],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c], 0x0627: [0xfe8d, 0xfe8e], 0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92], 0x0629: [0xfe93, 0xfe94],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98], 0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c], 0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4], 0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8], 0x062f: [0xfea9, 0xfeaa], 0x0630: [0xfeab, 0xfeac],
  0x0631: [0xfead, 0xfeae], 0x0632: [0xfeaf, 0xfeb0], 0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4], 0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc], 0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0], 0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8], 0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc], 0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4], 0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8], 0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0], 0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4], 0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec], 0x0648: [0xfeed, 0xfeee], 0x0649: [0xfeef, 0xfef0], 0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
};
const LAM_ALEF = { 0x0622: [0xfef5, 0xfef6], 0x0623: [0xfef7, 0xfef8], 0x0625: [0xfef9, 0xfefa], 0x0627: [0xfefb, 0xfefc] };
const TATWEEL = 0x0640;
const isMark = (cp) => (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670; // harakat: no part in joining
const joinsLeft = (cp) => cp === TATWEEL || (FORMS[cp] && FORMS[cp].length === 4); // can join the next letter
const joinsRight = (cp) => cp === TATWEEL || !!FORMS[cp]; // can join the letter before

/** Arabic text with each letter in its joined form (logical order kept). */
export function shapeArabic(text) {
  const cps = [...String(text)].map((c) => c.codePointAt(0));
  const out = [];
  const near = (i, step) => { for (let j = i + step; j >= 0 && j < cps.length; j += step) if (!isMark(cps[j])) return cps[j]; return null; };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (!FORMS[cp]) { out.push(cp); continue; }
    const prev = near(i, -1), next = near(i, 1);
    // lam then alef: one ligature
    if (cp === 0x0644 && next !== null && LAM_ALEF[next]) {
      const j = cps.findIndex((c, k) => k > i && !isMark(c));
      out.push(LAM_ALEF[next][prev !== null && joinsLeft(prev) ? 1 : 0]);
      for (let k = i + 1; k < j; k++) out.push(cps[k]); // (marks on the lam)
      i = j; continue;
    }
    const fromRight = prev !== null && joinsLeft(prev); // the letter before reaches over to this one
    const toLeft = next !== null && joinsRight(next) && FORMS[cp].length === 4;
    const f = FORMS[cp];
    out.push(f.length === 1 ? f[0] : fromRight && toLeft ? f[3] : fromRight ? f[1] : toLeft ? f[2] : f[0]);
  }
  return String.fromCodePoint(...out);
}

const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
const dirOf = (ch) => (RTL.test(ch) ? 'R' : LTR.test(ch) || DIGIT.test(ch) ? 'L' : 'N');

/**
 * Units (characters, or words with their styles) in the order they're seen, for a line whose base direction is `rtl`.
 * `dir(unit)` gives 'R', 'L' or 'N' (neutral: spaces, punctuation). Neutrals between two of one direction take it;
 * others take the base direction.
 */
export function visualOrder(units, dir, rtl) {
  const d = units.map(dir);
  const base = rtl ? 'R' : 'L';
  for (let i = 0; i < d.length; i++) {
    if (d[i] !== 'N') continue;
    let j = i; while (j < d.length && d[j] === 'N') j++;
    const before = i > 0 ? d[i - 1] : base, after = j < d.length ? d[j] : base;
    const r = before === after ? before : base;
    for (let k = i; k < j; k++) d[k] = r;
    i = j - 1;
  }
  const runs = [];
  units.forEach((u, i) => { if (runs.length && runs[runs.length - 1].d === d[i]) runs[runs.length - 1].u.push(u); else runs.push({ d: d[i], u: [u] }); });
  for (const r of runs) if (r.d === 'R') r.u.reverse();
  if (rtl) runs.reverse();
  return runs.flatMap((r) => r.u.map((u) => ({ unit: u, rtl: r.d === 'R' })));
}

/** A line of text as drawn left to right: Arabic joined, right-to-left runs reversed (brackets mirrored). */
export function visual(text, rtl = isRtlText(text)) {
  const s = String(text ?? '');
  if (!hasRtl(s)) return s;
  return visualOrder([...shapeArabic(s)], dirOf, rtl).map(({ unit, rtl: r }) => (r && MIRROR[unit] ? MIRROR[unit] : unit)).join('');
}

/** A word's own characters as seen (for a line laid out word by word): Arabic joined, reversed when right to left. */
export const visualWord = (text) => (hasRtl(text) ? visual(text, true) : text);
/** Which way a word runs: 'R', 'L', or 'N' (spaces and punctuation only). */
export const wordDir = (text) => { let n = 'N'; for (const ch of String(text)) { const d = dirOf(ch); if (d === 'R') return 'R'; if (d === 'L') n = 'L'; } return n; };

// Presentation forms back to the letters they show (for a PDF's copy-and-search text): FE8E → 0627 (alef), FEFB → 0644 0627
const BASE = new Map();
for (const [cp, forms] of Object.entries(FORMS)) for (const f of forms) BASE.set(f, [Number(cp)]);
for (const [alef, forms] of Object.entries(LAM_ALEF)) for (const f of forms) BASE.set(f, [0x0644, Number(alef)]);
/** The characters a presentation-form glyph stands for ([cp] for anything else). */
export const logicalOf = (cp) => BASE.get(cp) || [cp];

/** A line put in the other order without joining letters (a line read back from a PDF: from as seen to as written). */
export function reorder(text, rtl = isRtlText(text)) {
  const s = String(text ?? '');
  if (!hasRtl(s)) return s;
  return visualOrder([...s], dirOf, rtl).map(({ unit, rtl: r }) => (r && MIRROR[unit] ? MIRROR[unit] : unit)).join('');
}
