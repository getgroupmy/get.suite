// Notion's export (Settings → Export → Markdown & CSV, a .zip): every page a Markdown file and every
// database a CSV, each name ending in Notion's 32-character id ("Roadmap 1a2b…9f.md"), sub-pages in a
// folder named like their page, pictures beside them. Brought in as Workspace documents and spreadsheets,
// with the ids taken off the names, pictures put in the documents and links between pages kept.
import { docFromMarkdown } from '../office/markdown.js';
import { parseCsv } from '../contactfiles.js';

const ID = /\s+[0-9a-f]{32}(?=$|\.[^./]+$|_all\.csv$)/i;

/** Whether the files look like a Notion export: its pages and databases carry Notion's ids. */
export function isNotionExport(names) {
  const pages = names.filter((n) => /\.(md|csv)$/i.test(n));
  const marked = pages.filter((n) => ID.test(n.slice(n.lastIndexOf('/') + 1)));
  return marked.length > 0 && marked.length >= pages.length / 2;
}

/** A path from the export, each folder and file without Notion's id (and a database's "_all" copy as the database). */
export function cleanNotionPath(p) {
  return p.split('/').map((seg) => seg.replace(ID, '').replace(/_all(\.csv)$/i, '$1')).join('/');
}

/** Of a database's two CSVs (the default view's, and "_all" with every row), only the second. */
export function notionSkip(name, names) {
  return /\.csv$/i.test(name) && !/_all\.csv$/i.test(name) && names.includes(name.replace(/\.csv$/i, '_all.csv'));
}

const resolve = (fromDir, href) => {
  let rel;
  try { rel = decodeURIComponent(href); } catch { rel = href; }
  const parts = (fromDir ? fromDir.split('/') : []).concat(rel.split('/'));
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
};

/**
 * A page's Markdown → a document. `fromDir` is the page's folder in the export (as in the .zip); `pictureFor(path)`
 * gives the Drive file id of a picture in the export (or null), `pageFor(path)` the address of another page's
 * new document (or null). Pictures on a line of their own become pictures; links to pages become links.
 */
export function docFromNotion(md, { fromDir = '', pictureFor = () => null, pageFor = () => null } = {}) {
  const pics = [];
  let text = String(md).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const m = /^\s*!\[([^\]]*)\]\(\s*<?([^)>]+?)>?\s*\)\s*$/.exec(line);
    if (!m || /^[a-z]+:/i.test(m[2])) return line;
    const id = pictureFor(resolve(fromDir, m[2]));
    if (!id) return line;
    pics.push({ fileId: id, alt: m[1] || resolve(fromDir, m[2]).split('/').pop().replace(/\.[^.]+$/, '') });
    return `\u0001${pics.length - 1}\u0001`;
  }).join('\n');
  // Links to other pages of the export (relative .md paths) point to their documents here.
  text = text.replace(/(\[[^\]]*\]\()\s*<?([^)>\s]+\.md)>?\s*\)/gi, (all, open, href) => {
    if (/^[a-z]+:/i.test(href)) return all;
    const to = pageFor(resolve(fromDir, href));
    return to ? `${open}${to})` : all;
  });
  const doc = docFromMarkdown(text);
  const swap = (nodes) => nodes.map((n) => {
    const only = n.type === 'paragraph' && n.content?.length === 1 && n.content[0].type === 'text' && /^\u0001(\d+)\u0001$/.exec(n.content[0].text);
    if (only) return { type: 'image', attrs: { fileId: pics[+only[1]].fileId, alt: pics[+only[1]].alt } };
    return n.content ? { ...n, content: swap(n.content) } : n;
  });
  return { ...doc, content: swap(doc.content || []) };
}

const colName = (n) => { let s = ''; for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** A database's CSV → a spreadsheet (heading row bold and kept in view). */
export function sheetFromNotionCsv(text, name) {
  const rows = parseCsv(String(text).replace(/^﻿/, ''), { keepEmpty: true }).slice(0, 20000);
  const cells = {}, formats = {};
  rows.forEach((row, r) => row.slice(0, 200).forEach((v, c) => {
    if (v === '') return;
    const k = `${colName(c)}${r + 1}`;
    cells[k] = /^=/.test(v) ? `'${v}` : v; // text from Notion is never run as a formula
    if (r === 0) formats[k] = { b: true };
  }));
  return { sheets: [{ name: String(name || 'Sheet1').slice(0, 100), cells, formats, colWidths: {}, ...(rows.length > 1 && { frozen: { rows: 1 } }) }] };
}
