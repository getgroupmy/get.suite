// IMPORTDATA and IMPORTHTML in Sheets: the server fetches a page on the internet (a CSV or TSV file,
// or a web page with tables or lists) for the spreadsheet, as only the server can (browsers block
// reading other sites). Addresses on private networks are refused (checked at connection time, so a
// name can't change in between), pages are kept for 5 minutes, and anything over 5 MB is refused.
// Mounted at /api/sheets-web: GET ?url=…&type=data|table|list&index=n → { rows: [[…]] }.
import { Router } from 'express';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { parseDocument, DomUtils } from 'htmlparser2';
import { HttpError } from '../util.js';
import { publicLookup, isPrivateAddress } from '../mail/unsubscribe.js';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000, MAX_COLS = 200;
const KEEP_MS = 5 * 60e3;
const cache = new Map(); // url → { at, text, type } (the newest 200)
const fail = (msg, status = 400) => new HttpError(status, msg);

/** Fetch a page (following up to 3 redirects), as text. */
export function fetchPage(address, { hops = 3, allowPrivate = process.env.SHEETS_IMPORT_ALLOW_PRIVATE === '1' } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(address); } catch { return reject(fail('That isn\'t a web address')); }
    if (!/^https?:$/.test(u.protocol)) return reject(fail('Only http and https addresses can be imported'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && (host === 'localhost' || (net.isIP(host) && isPrivateAddress(host)))) return reject(fail('That address is on a private network'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: allowPrivate ? undefined : publicLookup, timeout: 10000, headers: { 'user-agent': 'Workspace-Sheets/1.0', accept: 'text/csv,text/html,text/plain,*/*;q=0.5' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops <= 0) return reject(fail('Too many redirects'));
        return resolve(fetchPage(new URL(res.headers.location, u).toString(), { hops: hops - 1, allowPrivate }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(fail(`The page answered ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); reject(fail('That page is larger than 5 MB')); } else chunks.push(c); });
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] || '') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(fail('The page took too long to answer')));
    req.on('error', (e) => reject(e instanceof HttpError ? e : fail(e.code === 'EPRIVATE' ? 'That address is on a private network' : `Couldn't reach that page (${e.code || e.message})`)));
  });
}

/** A value as a spreadsheet keeps it: numbers as numbers ("1,234.5" too), the rest as text. */
export function cellValue(s) {
  const t = String(s ?? '').trim();
  if (t === '') return null;
  const n = t.replace(/,(?=\d{3}(\D|$))/g, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(n) ? Number(n) : t;
}

/** CSV (or TSV) as rows: quoted fields with commas, quotes and line breaks in them. */
export function parseDelimited(text, sep = ',') {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
      if (rows.length >= MAX_ROWS) break;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.slice(0, MAX_COLS).map(cellValue));
}

const textOf = (el) => DomUtils.textContent(el).replace(/\s+/g, ' ').trim();

/** The page's nth table (1 = the first) as rows; a cell that spans columns repeats its value across them. */
export function htmlTable(html, n) {
  const tables = DomUtils.getElementsByTagName('table', parseDocument(html).children, true);
  const table = tables[n - 1];
  if (!table) throw fail(tables.length ? `The page has ${tables.length} table${tables.length === 1 ? '' : 's'}` : 'The page has no tables');
  // Rows of this table only, not of tables inside its cells.
  const rows = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.type !== 'tag') continue;
      if (c.name === 'table') continue;
      if (c.name === 'tr') rows.push(c); else walk(c);
    }
  };
  walk(table);
  return rows.slice(0, MAX_ROWS).map((tr) => {
    const out = [];
    for (const td of (tr.children || []).filter((c) => c.type === 'tag' && (c.name === 'td' || c.name === 'th'))) {
      const span = Math.min(Math.max(1, Number(td.attribs?.colspan) || 1), 20);
      const v = cellValue(textOf(td));
      for (let k = 0; k < span; k++) out.push(v);
    }
    return out.slice(0, MAX_COLS);
  });
}

/** The page's nth list (ul or ol) as one column of its items. */
export function htmlList(html, n) {
  const lists = DomUtils.getElements({ tag_name: (name) => name === 'ul' || name === 'ol' }, parseDocument(html).children, true);
  const list = lists[n - 1];
  if (!list) throw fail(lists.length ? `The page has ${lists.length} list${lists.length === 1 ? '' : 's'}` : 'The page has no lists');
  return (list.children || []).filter((c) => c.type === 'tag' && c.name === 'li').slice(0, MAX_ROWS).map((li) => [cellValue(textOf(li))]);
}

async function page(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit;
  const got = { ...(await fetchPage(url)), at: Date.now() };
  cache.set(url, got);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return got;
}

export default function webImportRoutes() {
  const r = Router();
  r.get('/', async (req, res) => {
    const url = String(req.query.url || '').trim();
    const type = String(req.query.type || 'data');
    const index = Math.trunc(Number(req.query.index || 1));
    if (!url || url.length > 2000) throw fail('Give a web address');
    if (!['data', 'table', 'list'].includes(type)) throw fail('IMPORTHTML takes "table" or "list"');
    if (!(index >= 1 && index <= 1000)) throw fail('Which table or list: a number from 1');
    const { text, type: mime } = await page(url);
    let rows;
    if (type === 'data') {
      if (/text\/html/i.test(mime) || /^\s*<(!doctype|html)/i.test(text)) throw fail('That address is a web page, not CSV or TSV data: use IMPORTHTML for its tables');
      rows = parseDelimited(text, /tab-separated/i.test(mime) || /\.tsv(\?|$)/i.test(url) ? '\t' : ',');
    } else rows = type === 'table' ? htmlTable(text, index) : htmlList(text, index);
    while (rows.length && rows[rows.length - 1].every((v) => v === null)) rows.pop();
    if (!rows.length) throw fail('There\'s nothing in it to import');
    res.json({ rows });
  });
  return r;
}
