// Documents and Rich Text Format (.rtf: TextEdit, WordPad, Word): headings, paragraphs and their alignment, bold,
// italic, underline, strike, superscript and subscript, code (a fixed-width font), links, bulleted and numbered lists and
// checklists (as their marks, nested by their indent), quotes and code blocks (as styles of those names), tables, line
// breaks; equations, chips and footnotes as their text. Both ways, in plain JavaScript.
import { flattenTabs } from './doctabs.js';
import { chipText, dateText } from './chiptext.js';
import { inText } from './cite.js';

export const RTF_MIME = 'application/rtf';

// ---- out
const esc = (s) => [...String(s)].map((ch) => {
  const c = ch.codePointAt(0);
  if (ch === '\\' || ch === '{' || ch === '}') return `\\${ch}`;
  if (ch === '\n') return '\\line ';
  if (ch === '\t') return '\\tab ';
  if (c < 128) return ch;
  if (c < 0x10000) return `\\u${c > 32767 ? c - 65536 : c}?`;
  const hi = 0xd800 + ((c - 0x10000) >> 10), lo = 0xdc00 + ((c - 0x10000) & 0x3ff);
  return `\\u${hi - 65536}?\\u${lo - 65536}?`;
}).join('');
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const SIZES = { 1: 40, 2: 32, 3: 28, 4: 26, 5: 24, 6: 24 }; // half-points
const ALIGN = { center: '\\qc', right: '\\qr', justify: '\\qj' };

export function rtfFromDoc(doc) {
  doc = flattenTabs(doc);
  const inline = (list = []) => list.map((n) => {
    if (n.type === 'hardBreak') return '\\line ';
    const t = n.type === 'text' ? n.text || '' : n.type === 'mention' ? `@${n.attrs?.name || ''}` : n.type === 'datechip' ? dateText(n.attrs?.date) : n.type === 'filechip' ? n.attrs?.name || ''
      : n.type === 'dropchip' ? chipText(n.attrs) : n.type === 'math' ? n.attrs?.latex || '' : n.type === 'citation' ? inText(n.attrs) : n.type === 'footnote' ? ` [${n.attrs?.note || ''}]` : n.type === 'image' ? (n.attrs?.alt ? `[${n.attrs.alt}]` : '') : null;
    if (t === null) return inline(n.content);
    const marks = n.marks || [];
    let on = marks.map((m) => ({ bold: '\\b', italic: '\\i', underline: '\\ul', strike: '\\strike', superscript: '\\super', subscript: '\\sub', code: '\\f1' }[m.type])).filter(Boolean).join('');
    // right-to-left text (Hebrew, Arabic) takes its own bold, italic and font (\ab, \ai, \af), as Word and LibreOffice read them
    if (on && RTL.test(t)) on = `\\rtlch${on.replace(/\\b(?![a-z])/, '\\ab\\b').replace(/\\i(?![a-z])/, '\\ai\\i').replace(/\\f1/, '\\af1\\f1')}`;
    let run = on ? `{${on} ${esc(t)}}` : esc(t);
    const link = marks.find((m) => m.type === 'link' && /^(https?:|mailto:)/i.test(m.attrs?.href || ''))?.attrs.href;
    if (link) run = `{\\field{\\*\\fldinst{HYPERLINK "${esc(link).replace(/"/g, '%22')}"}}{\\fldrslt{\\ul\\cf1 ${run}}}}`;
    return run;
  }).join('');
  const para = (content, pre = '', rest = '') => `{\\pard\\plain\\sa120${pre} ${inline(content)}${rest}\\par}\n`;
  const blocks = (list = [], depth = 0) => list.map((n) => {
    const a = ALIGN[n.attrs?.textAlign] || '';
    if (n.type === 'paragraph') return para(n.content, a);
    if (n.type === 'heading') { const lv = Math.min(6, n.attrs?.level || 1); return `{\\pard\\plain\\s${lv}\\outlinelevel${lv - 1}\\sb240\\sa120\\keepn${a}\\b\\fs${SIZES[lv]} ${inline(n.content)}\\par}\n`; }
    if (n.type === 'bulletList' || n.type === 'orderedList' || n.type === 'taskList') {
      return (n.content || []).map((li, k) => {
        const mark = n.type === 'bulletList' ? '\\u8226?' : n.type === 'taskList' ? (li.attrs?.checked ? '\\u9745?' : '\\u9744?') : `${(n.attrs?.start || 1) + k}.`;
        const [first, ...more] = li.content || [];
        const ind = 360 * (depth + 1);
        return `{\\pard\\plain\\sa60\\fi-360\\li${ind} ${mark}\\tab ${inline(first?.content)}\\par}\n${blocks(more, depth + 1)}`;
      }).join('');
    }
    if (n.type === 'blockquote') return (n.content || []).map((c) => (c.type === 'paragraph' ? para(c.content, `\\s11\\li720${a}`, '') : blocks([c], depth))).join(''); // (style Quote: it comes back as a quote)
    if (n.type === 'codeBlock') return `{\\pard\\plain\\s10\\sa120\\f1 ${esc((n.content || []).map((c) => c.text).join(''))}\\par}\n`; // (style Code: it comes back as code)
    if (n.type === 'horizontalRule') return '{\\pard\\plain\\brdrb\\brdrs\\brdrw10\\sa120\\par}\n';
    if (n.type === 'image') return n.attrs?.alt ? para([{ type: 'text', text: `[${n.attrs.alt}]` }]) : '';
    if (n.type === 'table') {
      return (n.content || []).map((r) => {
        const cells = r.content || [];
        const w = Math.floor(9000 / Math.max(1, cells.length));
        const head = cells.some((c) => c.type === 'tableHeader') ? '\\trhdr' : '';
        return `{\\trowd\\trgaph108${head}${cells.map((_, i) => `\\clbrdrt\\brdrs\\clbrdrl\\brdrs\\clbrdrb\\brdrs\\clbrdrr\\brdrs\\cellx${w * (i + 1)}`).join('')}\n${cells.map((c) => `\\pard\\intbl ${c.type === 'tableHeader' ? '\\b ' : ''}${(c.content || []).map((p) => inline(p.content)).join('\\line ')}${c.type === 'tableHeader' ? '\\b0' : ''}\\cell`).join(' ')}\\row}\n`;
      }).join('') + '\\pard\n';
    }
    if (n.type === 'pageBreak') return '{\\pard\\plain\\page\\par}\n';
    return n.content ? blocks(n.content, depth) : '';
  }).join('');
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fmodern Courier New;}}{\\colortbl;\\red17\\green85\\blue204;}{\\stylesheet{\\s0 Normal;}{\\s1\\b\\fs40 heading 1;}{\\s2\\b\\fs32 heading 2;}{\\s3\\b\\fs28 heading 3;}{\\s10\\f1 Code;}{\\s11\\li720 Quote;}}\n\\fs24\n${blocks(doc?.content || [])}}`;
}

// ---- in
const CP1252 = { 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178 };
const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'pgdsctbl', 'footnote', 'annotation', 'atnid', 'atnauthor', 'filetbl', 'revtbl', 'pntxtb', 'pntxta', 'nonshppict', 'bkmkstart', 'bkmkend', 'fldinst']);

/** An RTF file's text as a document (TipTap JSON). */
export function docFromRtf(buf) {
  const src = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  if (!/^\s*\{\\rtf/.test(src)) throw new Error('Not an RTF file');
  const content = [];
  // Styles named "Heading 1"… (Word's and LibreOffice's): their paragraphs are headings.
  const headingStyle = new Map(), codeStyle = new Set(), quoteStyle = new Set();
  for (const m of src.matchAll(/\{\\s(\d+)((?:\\[a-z]+-?\d* ?)*)([^;{}\\]*);\}/g)) {
    const lv = /^\s*heading\s*([1-6])\s*$/i.exec(m[3])?.[1];
    if (lv) headingStyle.set(Number(m[1]), Number(lv));
    if (/^\s*(code|preformatted text|html preformatted|source text)\s*$/i.test(m[3])) codeStyle.add(Number(m[1])); // (code blocks)
    if (/^\s*(quote|quotations|block text)\s*$/i.test(m[3])) quoteStyle.add(Number(m[1]));
  }
  // Fixed-width fonts in the font table (\fmodern, or a name such as Courier): text in one is code.
  const monoFont = new Set();
  const fonttbl = /\{\\fonttbl([\s\S]*?)\}\s*(?:\{\\colortbl|\{\\stylesheet|\{\\\*|\\)/.exec(src)?.[1] || '';
  for (const m of fonttbl.matchAll(/\\f(\d+)((?:\\[a-z]+-?\d* ?)*)\s*([^;{}]*);/g)) if (/\\fmodern/.test(m[2]) || /courier|consolas|mono|menlo|monaco/i.test(m[3])) monoFont.add(Number(m[1]));
  const freshP = () => ({ align: null, outline: null, style: null, intbl: false, mark: null, li: 0, ilvl: null, mono: true });
  let para = [], pState = freshP();
  let lists = []; // the lists open now, outermost first: { list, level }
  let table = null, row = [], cell = [];
  const fresh = () => ({ listtext: false, b: false, i: false, ul: false, strike: false, sup: false, sub: false, skip: false, uc: 1, link: null, fldinst: false, field: null, f: 0, ab: false, ai: false, af: -1 });
  let st = fresh();
  const stack = [];
  let pendingSkip = 0; // characters to skip after \uN
  let fieldText = '';
  const addText = (t) => {
    if (!t || st.skip) return;
    if (st.fldinst) { fieldText += t; return; }
    if (st.listtext) { pState.mark = (pState.mark || '') + t; return; } // (a list item's number or bullet)
    // (right-to-left words: their own bold, italic and font, \ab \ai \af, as LibreOffice and Word write them)
    const rtl = RTL.test(t) && !/[A-Za-z0-9]/.test(t);
    const code = rtl ? monoFont.has(st.af) || (st.af === -1 && monoFont.has(st.f)) : monoFont.has(st.f);
    if (!code && /\S/.test(t)) pState.mono = false;
    const marks = [(rtl ? st.ab || st.b : st.b) && { type: 'bold' }, (rtl ? st.ai || st.i : st.i) && { type: 'italic' }, st.ul && !st.link && { type: 'underline' }, st.strike && { type: 'strike' }, st.sup && { type: 'superscript' }, st.sub && { type: 'subscript' }, code && { type: 'code' }, st.link && { type: 'link', attrs: { href: st.link } }].filter(Boolean);
    const last = para[para.length - 1];
    if (last && last.type === 'text' && JSON.stringify(last.marks || []) === JSON.stringify(marks)) last.text += t;
    else para.push({ type: 'text', text: t, ...(marks.length && { marks }) });
  };
  // A list item at its level (Word's \\ilvl, or the indent: 360 twips a level, as written here): into the list open at that
  // level, a new list inside the last item of the one above, or a new list at the top.
  const addItem = (item, kind, start = 1) => {
    const level = pState.ilvl ?? Math.max(0, Math.round(pState.li / 360) - 1);
    while (lists.length && lists[lists.length - 1].level > level) lists.pop();
    const top = lists[lists.length - 1];
    if (top && top.level === level && top.list.type === kind) { top.list.content.push(item); return; }
    const list = { type: kind, ...(kind === 'orderedList' && { attrs: { start } }), content: [item] };
    if (top && top.level === level) lists.pop();
    const parent = lists[lists.length - 1];
    if (parent && parent.level < level) parent.list.content[parent.list.content.length - 1].content.push(list);
    else { lists = []; content.push(list); }
    lists.push({ list, level });
  };
  const endPara = () => {
    const nodes = para;
    para = [];
    if (pState.intbl) { cell.push(nodes); return; }
    if (table) { content.push(table); table = null; }
    const align = pState.align ? { textAlign: pState.align } : {};
    const text = nodes.map((n) => n.text || '').join('');
    if (codeStyle.has(pState.style)) { lists = []; content.push({ type: 'codeBlock', ...(text && { content: [{ type: 'text', text }] }) }); return; }
    // A checklist item: its box, a tab, its words (as written here; LibreOffice and Word keep them so).
    const box = /^([☐☑☒])\t/.exec(text);
    if (box && nodes[0]?.type === 'text') {
      nodes[0] = { ...nodes[0], text: nodes[0].text.slice(box[0].length) };
      addItem({ type: 'taskItem', attrs: { checked: box[1] !== '☐' }, content: [{ type: 'paragraph', ...(nodes.some((x) => x.type !== 'text' || x.text) && { content: nodes.filter((x) => x.type !== 'text' || x.text) }) }] }, 'taskList');
      return;
    }
    const markText = pState.mark && pState.mark.replace(/\t/g, ' ').trim(); // (the list label Word and LibreOffice write)
    const bullet = markText ? ['', markText] : /^([•●▪◦·-]|\d{1,3}[.)])(?:\t| +)/.exec(text); // (one tab after the mark, as written here: an item's own leading spaces stay)
    const level = pState.outline ?? (headingStyle.has(pState.style) ? headingStyle.get(pState.style) - 1 : null);
    if (level !== null && level < 6 && text.trim()) (lists = [], content).push({ type: 'heading', attrs: { level: level + 1, ...align }, content: nodes.map((n) => ({ ...n, marks: (n.marks || []).filter((m) => m.type !== 'bold') })).map((n) => (n.marks?.length ? n : { type: n.type, text: n.text })) });
    else if (bullet && (markText || nodes[0]?.type === 'text')) {
      if (!markText) nodes[0] = { ...nodes[0], text: nodes[0].text.slice(bullet[0].length) };
      const kind = /\d/.test(bullet[1]) ? 'orderedList' : 'bulletList';
      addItem({ type: 'listItem', content: [{ type: 'paragraph', content: nodes.filter((n) => n.type !== 'text' || n.text) }] }, kind, Number(/\d+/.exec(bullet[1])?.[0]) || 1);
    } else if (quoteStyle.has(pState.style)) {
      lists = [];
      const p = { type: 'paragraph', ...(pState.align && { attrs: align }), ...(nodes.length && { content: nodes }) };
      const prev = content[content.length - 1];
      if (prev?.type === 'blockquote' && prev.fromRtf) prev.content.push(p); else content.push({ type: 'blockquote', fromRtf: true, content: [p] });
    } else { lists = []; content.push({ type: 'paragraph', ...(pState.align && { attrs: align }), ...(nodes.length && { content: nodes }) }); }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '{') { stack.push({ ...st }); i++; if (src.startsWith('\\*', i)) { st.skip = true; } continue; }
    if (ch === '}') {
      const was = st;
      st = stack.pop() || fresh();
      if (was.field && !st.field) st.link = null;
      if (was.fldinst && !st.fldinst) { const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/.exec(fieldText); st.field = m ? m[1] : st.field; fieldText = ''; }
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    if (ch !== '\\') {
      let j = i;
      while (j < n && !'\\{}\r\n'.includes(src[j])) j++;
      let t = src.slice(i, j);
      if (pendingSkip) { const k = Math.min(pendingSkip, t.length); t = t.slice(k); pendingSkip -= k; }
      addText([...t].map((c) => String.fromCodePoint(CP1252[c.charCodeAt(0)] || c.charCodeAt(0))).join(''));
      i = j;
      continue;
    }
    // a control word or symbol
    const sym = src[i + 1];
    if (sym === '\\' || sym === '{' || sym === '}') { addText(sym); i += 2; continue; }
    if (sym === "'") { if (pendingSkip) { pendingSkip--; i += 4; continue; } const c = parseInt(src.substr(i + 2, 2), 16); addText(String.fromCodePoint(CP1252[c] || c)); i += 4; continue; }
    if (sym === '~') { addText('\u00a0'); i += 2; continue; }
    if (sym === '-' || sym === '_') { if (sym === '_') addText('-'); i += 2; continue; }
    if (sym === '*') { st.skip = true; i += 2; continue; }
    const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i + 1, i + 50));
    if (!m) { i += 2; continue; }
    i += 1 + m[0].length;
    const word = m[1], arg = m[2] === undefined ? null : Number(m[2]);
    if (SKIP.has(word)) { st.skip = true; if (word === 'fldinst') { st.skip = false; st.fldinst = true; } continue; }
    switch (word) {
      case 'par': endPara(); break;
      case 'line': addText('\n'); break; // (a line break: kept as one in the text, made a break below)
      case 'tab': addText('\t'); break;
      case 'emdash': addText('—'); break; case 'endash': addText('–'); break; case 'bullet': addText('•'); break;
      case 'lquote': addText('‘'); break; case 'rquote': addText('’'); break; case 'ldblquote': addText('“'); break; case 'rdblquote': addText('”'); break;
      case 'u': { let c = arg < 0 ? arg + 65536 : arg; addText(String.fromCharCode(c)); pendingSkip = st.uc; c = 0; break; }
      case 'uc': st.uc = arg ?? 1; break;
      case 'b': st.b = arg !== 0; break;
      case 'i': st.i = arg !== 0; break;
      case 'ul': st.ul = arg !== 0; break; case 'ulnone': st.ul = false; break;
      case 'strike': st.strike = arg !== 0; break;
      case 'super': st.sup = true; st.sub = false; break; case 'sub': st.sub = true; st.sup = false; break; case 'nosupersub': st.sup = false; st.sub = false; break;
      case 'plain': Object.assign(st, { b: false, i: false, ul: false, strike: false, sup: false, sub: false, f: 0, ab: false, ai: false, af: -1 }); break;
      case 'pard': if (!st.listtext) pState = freshP(); break;
      case 'li': pState.li = arg ?? 0; break;
      case 'ilvl': pState.ilvl = arg ?? 0; break;
      case 'f': st.f = arg ?? 0; break;
      case 'ab': st.ab = arg !== 0; break;
      case 'ai': st.ai = arg !== 0; break;
      case 'af': st.af = arg ?? 0; break;
      case 'listtext': case 'pntext': st.listtext = true; st.skip = false; break;
      case 'qc': pState.align = 'center'; break; case 'qr': pState.align = 'right'; break; case 'qj': pState.align = 'justify'; break; case 'ql': pState.align = null; break;
      case 'outlinelevel': pState.outline = arg ?? 0; break;
      case 's': pState.style = arg; break;
      case 'intbl': pState.intbl = true; break;
      case 'cell': if (para.length || pState.intbl) { const nodes = para; para = []; cell.push(nodes); } row.push(cell); cell = []; break;
      case 'row': { const r = row; row = []; lists = []; /* (a table ends the lists before it) */ if (!table) table = { type: 'table', content: [] }; table.content.push({ type: 'tableRow', content: r.map((ps) => ({ type: table.content.length === 0 && r.length ? 'tableCell' : 'tableCell', content: ps.filter((p) => p.length).map((p) => ({ type: 'paragraph', content: p })).concat(ps.some((p) => p.length) ? [] : [{ type: 'paragraph' }]) })) }); break; }
      case 'fldrslt': st.link = st.field || null; break;
      case 'field': st.field = null; break;
      case 'page': if (para.length) endPara(); lists = []; content.push({ type: 'pageBreak' }); break;
      default: break;
    }
    if (word === 'fldrslt') st.skip = false;
  }
  if (para.length) endPara();
  if (table) content.push(table);
  // Line breaks inside paragraphs: as breaks.
  const breaks = (nodes) => nodes.flatMap((x) => (x.type === 'text' && x.text.includes('\n') ? x.text.split('\n').flatMap((t, k) => [...(k ? [{ type: 'hardBreak' }] : []), ...(t ? [{ ...x, text: t }] : [])]) : [x]));
  const fix = (node) => { if (node.content && node.type !== 'table') node.content = node.type === 'paragraph' || node.type === 'heading' ? breaks(node.content) : node.content.map(fix); if (node.type === 'table') node.content.forEach((r) => r.content.forEach((c) => c.content.forEach((p) => { if (p.content) p.content = breaks(p.content); }))); return node; };
  const out = content.map(fix);
  for (const b of out) delete b.fromRtf;
  // (the empty paragraph a file needs after a table that ends it, as LibreOffice and Word write one: not the document's)
  if (out.length > 1 && out.at(-2).type === 'table' && out.at(-1).type === 'paragraph' && !out.at(-1).content?.length) out.pop();
  // LibreOffice writes each space of a run of them as U+2006 (a six-per-em space) then a space: one space each, as typed
  (function spaces(n) { if (n.type === 'text' && n.text.includes('\u2006 ')) n.text = n.text.replace(/\u2006 /g, ' '); (n.content || []).forEach(spaces); })({ content: out });
  return { type: 'doc', content: out.length ? out : [{ type: 'paragraph' }] };
}
