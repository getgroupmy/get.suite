// The words in a PDF, for search (Drive finds a PDF by what it says): each page's text operators (Tj, TJ, ', ") read in
// order, through each font's ToUnicode map where it has one, else its encoding (WinAnsi, MacRoman or the standard one,
// with its Differences); form XObjects too. Lines break where the text moves down a line. pdf-lib parses the file.
import { hasRtl, reorder } from './bidi.js';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFRawStream, PDFStream, PDFNumber, decodePDFRawStream } from 'pdf-lib';

/** Mostly right-to-left letters (a line read back from the PDF in the order drawn)? */
const rtlMostly = (line) => (line.match(/[\u0590-\u08ff]/g) || []).length > (line.match(/[A-Za-z\u00c0-\u024f\u0400-\u04ff]/g) || []).length;
const bytesOfStream = (s) => {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  if (s instanceof PDFStream && typeof s.getContents === 'function') return s.getContents();
  return new Uint8Array(0);
};

// ---- glyph names (a font's Differences) to characters: the usual ones; uniXXXX and uXXXX[XX] by their numbers
const NAMES = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')',
  asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', endash: '–', emdash: '—', bullet: '•',
  ellipsis: '…', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', Euro: '€', minus: '−', degree: '°', copyright: '©',
  registered: '®', trademark: '™', eacute: 'é', egrave: 'è', ecircumflex: 'ê', agrave: 'à', aacute: 'á', ccedilla: 'ç', udieresis: 'ü',
  odieresis: 'ö', adieresis: 'ä', Udieresis: 'Ü', Odieresis: 'Ö', Adieresis: 'Ä', germandbls: 'ß', ntilde: 'ñ', oacute: 'ó', iacute: 'í', uacute: 'ú',
  quotesinglbase: '‚', quotedblbase: '„', dagger: '†', daggerdbl: '‡', section: '§', paragraph: '¶', periodcentered: '·', nbspace: ' ',
};
const glyphName = (n) => {
  if (NAMES[n] !== undefined) return NAMES[n];
  if (/^[A-Za-z]$/.test(n)) return n;
  let m = /^uni([0-9A-F]{4})+$/i.exec(n);
  if (m) return n.slice(3).match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-F]{4,6})$/i.exec(n);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return '';
};
const WIN = new TextDecoder('windows-1252');
const winAnsi = Array.from({ length: 256 }, (_, i) => (i < 32 ? '' : WIN.decode(new Uint8Array([i]))));
const MAC = { 0x80: 'Ä', 0x81: 'Å', 0x82: 'Ç', 0x83: 'É', 0x84: 'Ñ', 0x85: 'Ö', 0x86: 'Ü', 0x87: 'á', 0x88: 'à', 0x89: 'â', 0x8a: 'ä', 0x8e: 'é', 0x8f: 'è', 0x92: 'í', 0x96: 'ñ', 0x97: 'ó', 0x9a: 'ö', 0x9c: 'ú', 0x9f: 'ü', 0xa7: 'ß', 0xd0: '–', 0xd1: '—', 0xd2: '“', 0xd3: '”', 0xd4: '‘', 0xd5: '’' };
const macRoman = Array.from({ length: 256 }, (_, i) => (i < 32 ? '' : i < 128 ? String.fromCharCode(i) : MAC[i] || ''));

// ---- a ToUnicode CMap: { bytes (code length), map: Map(code → text) }
function parseCMap(text) {
  const map = new Map();
  let bytes = 1;
  const hex = (h) => parseInt(h, 16);
  const utf16 = (h) => { const u = []; for (let i = 0; i + 4 <= h.length; i += 4) u.push(hex(h.slice(i, i + 4))); return String.fromCharCode(...u); };
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) { const r = /<([0-9a-fA-F]+)>/.exec(m[1]); if (r) bytes = Math.max(1, r[1].length / 2); }
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(hex(p[1]), utf16(p[2]));
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = hex(p[1]), hi = hex(p[2]);
      if (hi - lo > 65535) continue;
      if (p[3] !== undefined) { const base = p[3]; for (let c = lo; c <= hi; c++) { const last = hex(base.slice(-4)) + (c - lo); map.set(c, utf16(base.slice(0, -4) + last.toString(16).padStart(4, '0'))); } }
      else [...p[4].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, k) => map.set(lo + k, utf16(d[1])));
    }
  }
  return { bytes, map };
}

/** How to read a font's strings: decode(bytes) → text. */
function fontReader(ctx, fontDict) {
  const get = (d, k) => { const v = d?.get(PDFName.of(k)); return v instanceof PDFRef ? ctx.lookup(v) : v; };
  const tu = get(fontDict, 'ToUnicode');
  const subtype = String(get(fontDict, 'Subtype') || '');
  if (tu instanceof PDFStream || tu instanceof PDFRawStream) {
    const cmap = parseCMap(new TextDecoder('latin1').decode(bytesOfStream(tu)));
    const n = subtype === '/Type0' ? Math.max(2, cmap.bytes) : cmap.bytes;
    return (b) => { let s = ''; for (let i = 0; i + n <= b.length; i += n) { let c = 0; for (let k = 0; k < n; k++) c = c * 256 + b[i + k]; s += cmap.map.get(c) ?? ''; } return s; };
  }
  if (subtype === '/Type0') return () => ''; // (no map to text: nothing that can be read)
  let table = winAnsi;
  const enc = get(fontDict, 'Encoding');
  const encName = enc instanceof PDFName ? String(enc) : String(get(enc, 'BaseEncoding') || '');
  if (encName === '/MacRomanEncoding') table = macRoman;
  table = [...table];
  const diffs = enc instanceof PDFDict ? get(enc, 'Differences') : null;
  if (diffs instanceof PDFArray) {
    let code = 0;
    for (const x of diffs.asArray()) {
      const v = x instanceof PDFRef ? ctx.lookup(x) : x;
      if (v instanceof PDFNumber) code = v.asNumber(); else if (v instanceof PDFName) { table[code] = glyphName(String(v).slice(1)); code++; }
    }
  }
  return (b) => Array.from(b, (c) => table[c] || '').join('');
}

// ---- a content stream's tokens: numbers, names, strings (bytes), arrays, operators
function* tokens(b) {
  const n = b.length;
  let i = 0;
  const ws = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const delim = (c) => ws(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  while (i < n) {
    const c = b[i];
    if (ws(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // % comment
    if (c === 40) { // (literal string)
      const out = []; let depth = 1; i++;
      while (i < n && depth) {
        let ch = b[i++];
        if (ch === 92) {
          const e = b[i++];
          const esc = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[e];
          if (esc !== undefined) out.push(esc);
          else if (e >= 48 && e <= 55) { let v = e - 48; for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48); out.push(v & 255); }
          else if (e === 13) { if (b[i] === 10) i++; } else if (e !== 10) out.push(e);
          continue;
        }
        if (ch === 40) depth++; else if (ch === 41 && !--depth) break;
        out.push(ch);
      }
      yield { s: Uint8Array.from(out) }; continue;
    }
    if (c === 60 && b[i + 1] === 60) { yield { op: '<<' }; i += 2; continue; }
    if (c === 62 && b[i + 1] === 62) { yield { op: '>>' }; i += 2; continue; }
    if (c === 60) { // <hex string>
      let j = i + 1, h = '';
      while (j < n && b[j] !== 62) { const ch = b[j++]; if (!ws(ch)) h += String.fromCharCode(ch); }
      if (h.length % 2) h += '0';
      yield { s: Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16)) }; i = j + 1; continue;
    }
    if (c === 91 || c === 93) { yield { op: c === 91 ? '[' : ']' }; i++; continue; }
    if (c === 47) { let j = i + 1; while (j < n && !delim(b[j])) j++; yield { name: String.fromCharCode(...b.subarray(i + 1, j)) }; i = j; continue; }
    let j = i; while (j < n && !delim(b[j])) j++;
    if (j === i) { i++; continue; }
    const word = String.fromCharCode(...b.subarray(i, j)); i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { num: Number(word) }; continue; }
    if (word === 'BI') { // an inline image: skip to EI
      while (i < n - 2 && !(b[i] === 69 && b[i + 1] === 73 && ws(b[i + 2] ?? 32) && ws(b[i - 1]))) i++;
      i += 2; continue;
    }
    yield { op: word };
  }
}

/** The text of a PDF (pages one after another), or '' when it can't be read. */
export async function textOfPdf(bytes, { maxPages = 300 } = {}) {
  let doc;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false }); } catch { return ''; }
  const ctx = doc.context;
  const look = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const out = [];
  const readers = new Map();
  const run = (content, resources, depth = 0) => {
    const fonts = look(resources?.get(PDFName.of('Font')));
    const xobjects = look(resources?.get(PDFName.of('XObject')));
    let read = () => '';
    let lastY = null, stack = [], arr = null;
    // where the text is (Tm, Td), roughly where the last of it ended (a character ≈ half the size, a CJK one the size),
    // so a piece drawn right after (a word split between fonts) isn't taken for a new word
    let x = 0, endX = null, size = 12, scale = 1, tfSize = 12;
    const wide = (ch) => /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch);
    let pendingLine = false; // T* (next line): a new line only when text follows it (pdf-lib ends each string with one)
    const say = (b) => { const t = read(b); if (!t) return; if (pendingLine) { newLine(); endX = null; pendingLine = false; } out.push(t); endX = (endX ?? x) + [...t].reduce((a, ch) => a + (wide(ch) ? 1 : 0.5), 0) * size; };
    const gapTo = (nx) => { if (endX !== null && nx - endX > size * 0.3 && out.length && !/\s$/.test(out[out.length - 1])) out.push(' '); };
    const newLine = () => { if (out.length && out[out.length - 1] !== '\n') out.push('\n'); };
    for (const t of tokens(content)) {
      if (t.op === '[') { arr = []; continue; }
      if (t.op === ']') { stack.push({ arr }); arr = null; continue; }
      if (arr) { arr.push(t); continue; }
      if (!t.op || t.op === '<<' || t.op === '>>') { stack.push(t); continue; }
      const args = stack; stack = [];
      switch (t.op) {
        case 'Tf': {
          const name = args[0]?.name, f = look(fonts?.get(PDFName.of(name || '')));
          if (f instanceof PDFDict) { if (!readers.has(f)) readers.set(f, fontReader(ctx, f)); read = readers.get(f); }
          tfSize = args[1]?.num || tfSize; size = Math.abs(tfSize * scale) || 12;
          break;
        }
        case 'Tj': if (args[0]?.s) say(args[0].s); break;
        case "'": case '"': newLine(); if (args[args.length - 1]?.s) say(args[args.length - 1].s); break;
        case 'TJ': for (const e of args[0]?.arr || []) { if (e.s) say(e.s); else if (e.num !== undefined && e.num < -200) { out.push(' '); endX = (endX ?? x) - (e.num / 1000) * size; } } break;
        case 'Td': case 'TD': if (args[1]?.num) { newLine(); endX = null; } else { const nx = x + (args[0]?.num || 0) * scale; gapTo(nx); x = nx; endX = null; } break;
        case 'T*': pendingLine = true; break;
        case 'Tm': {
          pendingLine = false;
          const y = args[5]?.num, nx = args[4]?.num ?? 0;
          scale = Math.hypot(args[0]?.num ?? 1, args[1]?.num ?? 0) || 1; size = Math.abs(tfSize * scale) || 12;
          if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 1) { newLine(); endX = null; } else gapTo(nx);
          x = nx; if (endX !== null && nx > endX) endX = null; lastY = y ?? lastY;
          break;
        }
        case 'BT': x = 0; pendingLine = false; break;
        case 'Do': {
          const x = look(xobjects?.get(PDFName.of(args[0]?.name || '')));
          if (depth < 4 && x && String(x.dict?.get(PDFName.of('Subtype'))) === '/Form') run(bytesOfStream(x), look(x.dict.get(PDFName.of('Resources'))) || resources, depth + 1);
          break;
        }
        default:
      }
    }
  };
  for (const page of doc.getPages().slice(0, maxPages)) {
    try {
      const c = look(page.node.get(PDFName.of('Contents')));
      const parts = c instanceof PDFArray ? c.asArray().map(look) : [c];
      const all = parts.filter(Boolean).map(bytesOfStream);
      const joined = new Uint8Array(all.reduce((a, x) => a + x.length + 1, 0)); let p = 0;
      for (const x of all) { joined.set(x, p); p += x.length; joined[p++] = 10; }
      run(joined, page.node.Resources());
    } catch { /* an unreadable page: the rest still */ }
    out.push('\n\n');
  }
  // Lines with Hebrew or Arabic: drawn in the order seen, read back in the order written; joined Arabic forms and
  // ligatures (ﬁ) as their letters (NFKC)
  return out.join('').replace(/[\ufb00-\ufb06\ufb50-\ufdff\ufe70-\ufeff]+/g, (m) => m.normalize('NFKC')).split('\n').map((line) => (hasRtl(line) ? reorder(line, rtlMostly(line)) : line)).join('\n')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
