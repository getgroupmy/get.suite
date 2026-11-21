// Opening plain files as Docs and Sheets: a text file (.txt) as a document (each line a paragraph), a web page
// (.html, .htm) as a document (its pictures in it saved to Drive, equations in MathML as equations, footnotes as
// our web page download writes them as footnotes), and CSV / TSV files as spreadsheets.
import { docFromHtml } from './word.js';
import { mathmlToLatex } from './mathml.js';
import { parseCsv, csvSeparator } from '../contactfiles.js';
import { typedCells } from '../sheetcalc/cellformat.js';
import { colName } from './sheetnames.js';

const decode = (buf) => { const s = Buffer.from(buf).toString('utf8'); return s.replace(/^﻿/, '').replace(/\r\n?/g, '\n'); };
const h = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unh = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** A text file as a document: each line a paragraph (blank lines kept). */
export function docFromTextFile(buf) {
  const lines = decode(buf).replace(/\n+$/, '').split('\n').slice(0, 200000);
  return { type: 'doc', content: lines.length && lines.some((l) => l) ? lines.map((l) => (l ? { type: 'paragraph', content: [{ type: 'text', text: l.replace(/\t/g, '    ') }] } : { type: 'paragraph' })) : [{ type: 'paragraph' }] };
}

/** A web page as a document. `savePicture(name, data, mime)` keeps a picture written into the page (data: address) as a Drive file. */
export async function docFromWebPage(buf, { savePicture } = {}) {
  let html = decode(buf);
  html = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<(script|style|noscript|template|iframe|object|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<nav\b[^>]*class="toc"[^>]*>[\s\S]*?<\/nav>/gi, ''); // (our download's list of headings: made from the headings, not kept as text)
  // Footnotes as our download writes them: a numbered link to a note at the end.
  const notes = new Map();
  html = html.replace(/<section class="notes">([\s\S]*?)<\/section>/i, (m, inner) => {
    for (const p of inner.matchAll(/<p id="n(\d+)"><a href="#r\d+">\d+\.<\/a>\s*([\s\S]*?)<\/p>/g)) notes.set(p[1], unh(p[2].replace(/<[^>]+>/g, '')).trim());
    return notes.size ? '' : m;
  });
  html = html.replace(/<a id="r(\d+)" href="#n\d+"><sup>\d+<\/sup><\/a>/g, (m, k) => (notes.has(k) ? `<sup data-footnote="" data-note="${h(notes.get(k))}"></sup>` : m));
  // Footnotes as pandoc and others mark them (ARIA's doc-endnotes and doc-noteref): the notes at the end, each linked from
  // its number in the text; their link back left out.
  const endnotes = new Map();
  html = html.replace(/<(aside|section|div)\b[^>]*role="doc-endnotes"[^>]*>([\s\S]*?)<\/\1>/i, (m, tag, inner) => {
    for (const li of inner.matchAll(/<li\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)) {
      endnotes.set(li[1], unh(li[2].replace(/<a\b[^>]*(?:role="doc-backlink"|class="footnote-back")[^>]*>[\s\S]*?<\/a>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
    }
    return endnotes.size ? '' : m;
  });
  html = html.replace(/<a\b([^>]*)>\s*(?:<sup>)?\s*[\w*†‡]+\s*(?:<\/sup>)?\s*<\/a>/g, (m, attrs) => {
    const id = /\bhref="#([^"]+)"/.exec(attrs)?.[1];
    return id && endnotes.has(id) && /role="doc-noteref"|class="footnote-ref"/.test(attrs) ? `<sup data-footnote="" data-note="${h(endnotes.get(id))}"></sup>` : m;
  });
  // Checklists as GitHub and pandoc write them: a list whose items start with a tick box (ticked: checked), made the box it shows.
  html = html.replace(/<input\b[^>]*\btype="checkbox"[^>]*>\s*/gi, (m) => (/\bchecked\b/i.test(m) ? '☒ ' : '☐ '));
  // Equations (MathML): as equations.
  html = html.replace(/<math\b[\s\S]*?<\/math>/gi, (m) => { const l = mathmlToLatex(m); return l ? `<span data-math="" data-latex="${h(l)}"></span>` : ''; });
  // Pictures in the page: saved to Drive; others (on the web) left as their description.
  let n = 0;
  const pics = [];
  html = html.replace(/<img\b[^>]*>/gi, (tag) => { pics.push(tag); return `\uE010${pics.length - 1}\uE011`; });
  const out = [];
  for (const tag of pics) {
    const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1] || '';
    const alt = unh(/\balt="([^"]*)"/i.exec(tag)?.[1] || '');
    const m = /^data:(image\/(png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(src);
    let id = null;
    if (m && savePicture && n < 200) { try { id = await savePicture(`Picture ${++n}.${m[2].replace('jpeg', 'jpg')}`, Buffer.from(m[3], 'base64'), m[1]); } catch { id = null; } }
    out.push(id ? `<img src="pic:${id}" alt="${h(alt)}">` : alt ? `<em>[${h(alt)}]</em>` : '');
  }
  html = html.replace(/<p class="picture">\s*(\uE010\d+\uE011)\s*<\/p>/g, '$1') // (a picture on its own: not in an empty paragraph too)
    .replace(/\uE010(\d+)\uE011/g, (m, k) => out[Number(k)]);
  return docFromHtml(html);
}

/** CSV or TSV text as a spreadsheet of one sheet named `name`. */
export function sheetFromDelimited(buf, name, sep = ',') {
  const text = decode(buf);
  const rows = sep === '\t' ? text.replace(/\n$/, '').split('\n').map((l) => l.split('\t')) : parseCsv(text, { keepEmpty: true });
  const raw = {};
  rows.slice(0, 50000).forEach((row, r) => row.slice(0, 500).forEach((v, c) => { if (v !== '') raw[`${colName(c)}${r + 1}`] = v; }));
  // "$1,250.00", "40%", "05/12/2026" as numbers and dates in their formats, as when typed in Sheets (and in a file with
  // semicolons, as Excel saves them in much of Europe, decimal commas: "1.234,50")
  const { cells, formats } = typedCells(raw, { decimalComma: sep !== '\t' && csvSeparator(text.replace(/^\uFEFF/, '')) === ';' });
  return { sheets: [{ name: String(name || 'Sheet1').slice(0, 100) || 'Sheet1', cells, ...(Object.keys(formats).length && { formats }) }] };
}
