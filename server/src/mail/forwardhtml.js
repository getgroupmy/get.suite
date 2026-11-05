// Turn a received email's HTML into a safe body for a reply quote or forward: the text with basic
// formatting (paragraphs, line breaks, bold/italic/underline/strike, lists, quotes, links), text
// colours, highlights, fonts and font sizes, alignment, indents, data tables, and the pictures embedded in it. Tables used only for page layout (as newsletters do) are
// flattened into paragraphs. Everything else — scripts, styles, forms, tracking pixels and pictures
// loaded from the internet — is dropped. The result only ever contains the handful of tags the
// message editor knows, so nothing from the original can run or phone home.
import { parseDocument } from 'htmlparser2';

const SKIP = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'button', 'select', 'textarea', 'input', 'video', 'audio', 'canvas', 'map']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'center', 'address', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'dl', 'dt', 'dd', 'pre', 'hr', 'fieldset', 'details', 'summary']);
const MARKS = { b: 'strong', strong: 'strong', i: 'em', em: 'em', cite: 'em', u: 'u', ins: 'u', s: 's', strike: 's', del: 's' };
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'th']);
const MAX_OUT = 1_000_000;
const MAX_ROWS = 200, MAX_COLS = 20;

// ---- text colours ----
const NAMED = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', navy: '000080', maroon: '800000',
  purple: '800080', teal: '008080', olive: '808000', gray: '808080', grey: '808080', silver: 'c0c0c0', orange: 'ffa500',
  yellow: 'ffff00', lime: '00ff00', aqua: '00ffff', cyan: '00ffff', fuchsia: 'ff00ff', magenta: 'ff00ff', brown: 'a52a2a',
  darkred: '8b0000', darkgreen: '006400', darkblue: '00008b', darkorange: 'ff8c00', crimson: 'dc143c', royalblue: '4169e1',
  steelblue: '4682b4', dimgray: '696969', dimgrey: '696969', darkgray: 'a9a9a9', darkgrey: 'a9a9a9', indigo: '4b0082',
};
/** A CSS colour as six hex digits, or null. Only plain values: hex, rgb()/rgba(), common names. */
export function parseColor(value) {
  const v = String(value || '').trim().toLowerCase().replace(/\s*!important$/, '');
  let m;
  if ((m = v.match(/^#([0-9a-f]{3,4})$/))) return m[1].slice(0, 3).split('').map((c) => c + c).join('');
  if ((m = v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/))) return m[1];
  if ((m = v.match(/^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/))) {
    const ch = m.slice(1, 4).map((x) => Math.round(Math.min(255, Math.max(0, x.endsWith('%') ? parseFloat(x) * 2.55 : parseFloat(x)))));
    return ch.some((x) => !Number.isFinite(x)) ? null : ch.map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return NAMED[v] || null;
}
const luminance = (hex) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/**
 * The text colour an element sets: a hex colour, 'default' (it sets one, but it's near-black, the
 * normal text colour, or too light to read on a white page), or undefined (it doesn't set one).
 */
function colorOf(tag, a) {
  const decl = [...String(a.style || '').matchAll(/(?:^|;)\s*color\s*:\s*([^;]+)/gi)].pop()?.[1];
  const raw = decl ?? (tag === 'font' ? a.color : undefined);
  if (raw === undefined) return undefined;
  const hex = parseColor(raw);
  if (!hex) return /^\s*(inherit|initial|unset|currentcolor)\s*$/i.test(raw) ? undefined : 'default';
  const L = luminance(hex);
  return L < 0.02 || 1.05 / (L + 0.05) < 1.8 ? 'default' : `#${hex}`;
}
// Highlights: a light background on inline text (or <mark>). Backgrounds on paragraphs, cells and
// whole pages are newsletter styling, not highlighting, so they are left out.
const INLINE = new Set(['span', 'mark', 'font', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'a', 'code', 'small', 'big', 'sub', 'sup', 'cite', 'abbr', 'q']);
function highlightOf(tag, a) {
  if (!INLINE.has(tag)) return undefined;
  const style = String(a.style || '');
  const raw = [...style.matchAll(/(?:^|;)\s*background-color\s*:\s*([^;]+)/gi)].pop()?.[1]
    ?? [...style.matchAll(/(?:^|;)\s*background\s*:\s*([^;]+)/gi)].pop()?.[1];
  if (raw === undefined) return tag === 'mark' ? '#fef08a' : undefined;
  if (/^\s*(inherit|initial|unset)\s*$/i.test(raw)) return undefined;
  const hex = parseColor(raw); // a background with pictures or gradients isn't a plain colour: no highlight
  if (!hex) return 'none';
  const L = luminance(hex);
  return L < 0.45 || L > 0.93 ? 'none' : `#${hex}`; // dark text must stay readable; near-white is no highlight
}

// ---- font sizes: mapped onto the editor's Small / Normal / Large / Huge ----
const SIZE_WORDS = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const FONT_TAG_SIZES = { 1: 10, 2: 13, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
const HEADING_SIZES = { h1: '24px', h2: '18px' };
/** A size in px from a CSS value (px, pt, em/rem/% of 16px, keywords), or null. */
export function sizePx(value) {
  const v = String(value || '').trim().toLowerCase().replace(/\s*!important$/, '');
  if (SIZE_WORDS[v]) return SIZE_WORDS[v];
  const m = v.match(/^([\d.]+)\s*(px|pt|em|rem|%)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { pt: n * 4 / 3, em: n * 16, rem: n * 16, '%': n * 0.16 }[m[2]] ?? n;
}
const bucket = (px) => (px < 12.5 ? '12px' : px <= 16.5 ? 'default' : px <= 20.5 ? '18px' : '24px');
function sizeOf(tag, a) {
  const decl = [...String(a.style || '').matchAll(/(?:^|;)\s*font-size\s*:\s*([^;]+)/gi)].pop()?.[1];
  if (decl !== undefined) { const px = sizePx(decl); return px ? bucket(px) : undefined; }
  if (tag === 'font' && /^\s*[1-7]\s*$/.test(a.size || '')) return bucket(FONT_TAG_SIZES[a.size.trim()]);
  return HEADING_SIZES[tag];
}

// ---- fonts: common mail fonts, written out as fixed, safe font lists ----
const STACKS = {
  georgia: "Georgia, serif", 'times new roman': "'Times New Roman', Times, serif", times: "'Times New Roman', Times, serif",
  serif: "'Times New Roman', Times, serif", garamond: "Garamond, Georgia, serif", palatino: "'Palatino Linotype', Palatino, serif",
  'palatino linotype': "'Palatino Linotype', Palatino, serif", 'book antiqua': "'Palatino Linotype', Palatino, serif", cambria: "Cambria, Georgia, serif",
  'courier new': "'Courier New', Courier, monospace", courier: "'Courier New', Courier, monospace", monospace: "'Courier New', Courier, monospace",
  consolas: "Consolas, 'Courier New', monospace", menlo: "Consolas, 'Courier New', monospace", monaco: "Consolas, 'Courier New', monospace",
  'lucida console': "Consolas, 'Courier New', monospace", verdana: "Verdana, sans-serif", tahoma: "Tahoma, sans-serif",
  'trebuchet ms': "'Trebuchet MS', sans-serif", calibri: "Calibri, Arial, sans-serif", 'comic sans ms': "'Comic Sans MS', cursive",
  'century gothic': "'Century Gothic', sans-serif", 'lucida sans': "'Lucida Sans', sans-serif",
};
// The usual sans-serif fonts are the normal mail font: no font of their own (like near-black text).
const PLAIN = new Set(['arial', 'helvetica', 'helvetica neue', 'sans-serif', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'open sans', 'inter']);
/** The font a family list asks for: a safe font list, 'default', or null (nothing recognised). */
export function fontStack(value) {
  for (const name of String(value || '').split(',').map((f) => f.trim().replace(/^['"]|['"]$/g, '').toLowerCase())) {
    if (PLAIN.has(name)) return 'default';
    if (STACKS[name]) return STACKS[name];
  }
  return null;
}
function fontOf(tag, a) {
  const raw = [...String(a.style || '').matchAll(/(?:^|;)\s*font-family\s*:\s*([^;]+)/gi)].pop()?.[1] ?? (tag === 'font' ? a.face : undefined);
  if (raw === undefined) return undefined;
  return fontStack(raw) ?? undefined; // unknown fonts: keep what applies around them
}

const withColor = (marks, c) => (c === undefined ? marks : [...marks.filter((m) => !m.color), { color: c }]);
const withMark = (key, marks, v) => (v === undefined ? marks : [...marks.filter((m) => !(key in m)), { [key]: v }]);
/** Colour, highlight, size and font an element sets, applied to what's inside it. */
// ---- alignment: centre / right on paragraphs, headings, cells (and <center>); left is normal ----
const ALIGNABLE = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'center', 'address', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'li', 'blockquote', 'pre', 'dd', 'dt']);
function alignOf(tag, a) {
  if (tag === 'center') return 'center';
  if (!ALIGNABLE.has(tag)) return undefined; // (text-align on inline elements does nothing; <table align> only places the table)
  const raw = ([...String(a.style || '').matchAll(/(?:^|;)\s*text-align\s*:\s*([^;]+)/gi)].pop()?.[1] ?? a.align ?? '').trim().toLowerCase().replace(/\s*!important$/, '');
  if (!raw) return undefined;
  return raw === 'center' || raw === 'middle' ? 'center' : raw === 'right' || raw === 'end' ? 'right' : 'left'; // left, start, justify
}
/** A picture centred by its own margins (display:block; margin: 0 auto). */
const centredByMargins = (a) => /(?:^|;)\s*margin\s*:\s*(?:[^;]*\s)?auto\b/i.test(a.style || '')
  || (/margin-left\s*:\s*auto/i.test(a.style || '') && /margin-right\s*:\s*auto/i.test(a.style || ''));

// ---- indents: a left margin/padding on a paragraph or block, in 40px steps (as the editor's) ----
const INDENTABLE = new Set(['p', 'div', 'section', 'article', 'center', 'address', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'dd']);
const LENGTH_PX = { px: 1, pt: 4 / 3, em: 16, rem: 16, in: 96, cm: 37.8, mm: 3.78 };
/** Indent steps a block sets (0..8), or undefined. Gmail-style indents are handled at <blockquote>. */
function indentOf(tag, a) {
  if (!INDENTABLE.has(tag)) return undefined;
  const style = String(a.style || '');
  const raw = [...style.matchAll(/(?:^|;)\s*(?:margin|padding)-left\s*:\s*([^;]+)/gi)].map((m) => m[1]);
  if (!raw.length) return undefined;
  const px = raw.reduce((sum, v) => { const m = v.trim().match(/^([\d.]+)\s*(px|pt|em|rem|in|cm|mm)$/i); return sum + (m ? parseFloat(m[1]) * LENGTH_PX[m[2].toLowerCase()] : 0); }, 0);
  return Math.max(0, Math.min(8, Math.round(px / 40)));
}
const indentNow = (marks) => marks.find((m) => 'indent' in m)?.indent || 0;

const styled = (marks, tag, a) => withMark('indent', withMark('align', withMark('font', withMark('size', withMark('bg', withColor(marks, colorOf(tag, a)), highlightOf(tag, a)), sizeOf(tag, a)), fontOf(tag, a)), alignOf(tag, a)), indentOf(tag, a));
/** What carries on into list items, quotes and table cells (highlights are only for inline text). */
const inheritable = (marks) => marks.filter((m) => m.color || m.size || m.font || m.align);


const isTag = (n, ...names) => n?.type === 'tag' && names.includes(n.name);
const hasTable = (n) => (n.children || []).some((c) => c.type === 'tag' && (c.name === 'table' || hasTable(c)));
/** The rows of a table, looking through thead/tbody/tfoot (not into nested tables). */
function rowsOf(table) {
  const rows = [];
  for (const c of table.children || []) {
    if (isTag(c, 'tr')) rows.push(c);
    else if (isTag(c, 'thead', 'tbody', 'tfoot')) rows.push(...(c.children || []).filter((r) => isTag(r, 'tr')));
  }
  return rows;
}
const cellsOf = (row) => (row.children || []).filter((c) => isTag(c, 'td', 'th'));
const span = (v) => Math.min(MAX_COLS, Math.max(1, parseInt(v, 10) || 1));
/**
 * A table that holds data (an invoice, a schedule) rather than laying out the page: not marked as
 * presentation, no tables inside it, and at least two columns somewhere.
 */
function isDataTable(table) {
  if (/presentation|none/i.test(table.attribs?.role || '')) return false;
  if (hasTable(table)) return false;
  const rows = rowsOf(table);
  if (!rows.length || rows.length > MAX_ROWS) return false;
  const widths = rows.map((r) => cellsOf(r).reduce((n, c) => n + span(c.attribs?.colspan), 0));
  return Math.max(...widths) >= 2 && Math.max(...widths) <= MAX_COLS;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const safeHref = (h) => {
  const v = String(h || '').trim();
  return /^(https?:\/\/|mailto:)/i.test(v) && !/[\s<>"]/.test(v) ? v : null;
};

/**
 * @param {string} html  the original's HTML (parsed with cid: links kept)
 * @param {(cid: string) => string | null} pictureUrl  where the editor can show an embedded picture, or null to drop it
 * @returns {{ html: string, pictures: number }}
 */
export function forwardHtml(html, pictureUrl) {
  const doc = parseDocument(String(html || ''), { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  let pictures = 0;

  // A "flow" is the content of the body, a list item or a quote: paragraphs, pictures, lists, quotes.
  function flow(nodes, inherited = []) {
    const out = [];
    let para = ''; // the paragraph being built (inline HTML)
    let paraAlign = null; // its alignment and indent: those of the block its first text came from
    let paraIndent = 0;
    const flush = () => {
      const st = [(paraAlign === 'center' || paraAlign === 'right') && `text-align: ${paraAlign}`, paraIndent && `margin-left: ${paraIndent * 40}px`].filter(Boolean).join('; ');
      const attrs = `${paraIndent ? ` data-indent="${paraIndent}"` : ''}${st ? ` style="${st}"` : ''}`;
      if (para.replace(/<br>/g, '').trim()) out.push(`<p${attrs}>${para.replace(/^(\s|<br>)+|(\s|<br>)+$/g, '')}</p>`);
      para = '';
      paraAlign = null;
      paraIndent = 0;
    };
    const alignNow = (marks) => marks.find((m) => m.align)?.align;

    function inline(node, marks, pre) {
      if (node.type === 'text') {
        let t = node.data;
        if (pre) t = esc(t).replace(/\r?\n/g, '<br>');
        else t = esc(t.replace(/[\s ]+/g, (w) => (w.includes(' ') ? ' ' : ' ')));
        if (!t) return;
        if (!para || /<br>$/.test(para)) t = t.replace(/^ /, '');
        if (!para.trim()) { paraAlign = alignNow(marks) || null; paraIndent = indentNow(marks); }
        const color = marks.find((m) => m.color)?.color;
        const bg = marks.find((m) => m.bg)?.bg;
        const size = marks.find((m) => m.size)?.size;
        const font = marks.find((m) => m.font)?.font;
        const style = [color && color !== 'default' && `color: ${color}`, bg && bg !== 'none' && `background-color: ${bg}`,
          size && size !== 'default' && `font-size: ${size}`, font && font !== 'default' && `font-family: ${font}`].filter(Boolean).join('; ');
        let wrapped = style ? `<span style="${style}">${t}</span>` : t;
        for (const m of [...marks].reverse()) if (m.open) wrapped = m.open + wrapped + m.close;
        para += wrapped;
        return;
      }
      if (node.type !== 'tag') return; // comments, CDATA, directives
      const tag = node.name;
      if (SKIP.has(tag)) return;
      const a = node.attribs || {};
      if (tag === 'br') { para += '<br>'; return; }
      marks = styled(marks, tag, a); // colour, highlight, size and font apply to everything inside, until overridden
      if (tag === 'img') {
        const src = String(a.src || '').trim();
        const url = /^cid:/i.test(src) ? pictureUrl(src.slice(4).replace(/^<|>$/g, '')) : null;
        if (!url) return; // remote and data: pictures are left out
        flush();
        const alt = String(a.alt || '').slice(0, 200);
        const al = centredByMargins(a) ? 'center' : alignNow(marks);
        out.push(`<img src="${esc(url)}" alt="${esc(alt)}"${al === 'center' || al === 'right' ? ` data-align="${al}"` : ''}>`);
        pictures++;
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = (node.children || []).filter((c) => c.type === 'tag' && c.name === 'li');
        if (!items.length) { kids(node, marks, pre); return; }
        flush();
        out.push(`<${tag}>${items.map((li) => `<li>${flow(li.children || [], styled(inheritable(marks), 'li', li.attribs || {})) || '<p></p>'}</li>`).join('')}</${tag}>`);
        return;
      }
      // Gmail indents with a borderless <blockquote>: that's an indent step, not a quote.
      if (tag === 'blockquote' && /(?:^|;)\s*border\s*:\s*(?:none|0)\b/i.test(a.style || '')) {
        flush();
        kids(node, withMark('indent', marks, Math.min(8, indentNow(marks) + 1)), pre);
        flush();
        return;
      }
      if (tag === 'blockquote') {
        flush();
        const body = flow(node.children || [], inheritable(marks));
        if (body) out.push(`<blockquote>${body}</blockquote>`);
        return;
      }
      if (tag === 'hr') { flush(); return; }
      if (tag === 'table' && isDataTable(node)) {
        flush();
        const rows = rowsOf(node).map((r) => cellsOf(r).map((c) => {
          const t = c.name === 'th' ? 'th' : 'td';
          const a2 = c.attribs || {};
          const spans = `${span(a2.colspan) > 1 ? ` colspan="${span(a2.colspan)}"` : ''}${span(a2.rowspan) > 1 ? ` rowspan="${Math.min(MAX_ROWS, span(a2.rowspan))}"` : ''}`;
          const inCell = styled(styled(inheritable(marks), 'tr', r.attribs || {}), t, a2);
          return `<${t}${spans}>${flow(c.children || [], inCell) || '<p></p>'}</${t}>`;
        }).join('')).filter(Boolean);
        out.push(`<table><tbody>${rows.map((r) => `<tr>${r}</tr>`).join('')}</tbody></table>`);
        return;
      }
      let next = marks;
      if (MARKS[tag]) next = [...marks, { open: `<${MARKS[tag]}>`, close: `</${MARKS[tag]}>` }];
      if (HEADINGS.has(tag)) next = [...next, { open: '<strong>', close: '</strong>' }];
      if (tag === 'a') {
        const href = safeHref(a.href);
        if (href && !marks.some((m) => m.link)) next = [...next, { open: `<a href="${esc(href)}">`, close: '</a>', link: true }];
      }
      const block = BLOCK.has(tag) || tag === 'li';
      if (block) flush();
      kids(node, next, pre || tag === 'pre');
      if (block) flush();
      else if (tag === 'td' || tag === 'th') para += ' ';
    }
    const kids = (node, marks, pre) => { for (const c of node.children || []) inline(c, marks, pre); };

    for (const n of nodes) inline(n, inherited, false);
    flush();
    return out.join('');
  }

  const body = doc.children.find?.((n) => n.type === 'tag' && n.name === 'html')?.children?.find((n) => n.type === 'tag' && n.name === 'body');
  let out = flow((body || doc).children || []);
  if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT).replace(/<[^>]*$/, '');
  return { html: out, pictures };
}
