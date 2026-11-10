import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseDelimited, htmlTable, htmlList, cellValue, fetchPage } from '../src/routes/webimport.js';

test('CSV and TSV: quotes, commas and line breaks inside fields; numbers become numbers', () => {
  assert.deepEqual(parseDelimited('﻿Name,Price,Note\r\nTea,"1,250.50","Strong, black"\nCake,3,"two\nlines"\n'), [['Name', 'Price', 'Note'], ['Tea', 1250.5, 'Strong, black'], ['Cake', 3, 'two\nlines']]);
  assert.deepEqual(parseDelimited('a\tb\n1\t\n', '\t'), [['a', 'b'], [1, null]]);
  assert.deepEqual([cellValue(' 42 '), cellValue('-1e3'), cellValue('12 May'), cellValue('')], [42, -1000, '12 May', null]);
});

test('HTML: the nth table (spans repeated, nested tables left out) and the nth list', () => {
  const html = `<p>Rates</p><table><thead><tr><th>Currency</th><th>Rate</th></tr></thead><tbody>
    <tr><td>EUR</td><td>0.92</td></tr><tr><td colspan="2">Updated <b>daily</b></td></tr>
    <tr><td>Nested<table><tr><td>inner</td></tr></table></td><td>1</td></tr></tbody></table>
    <table><tr><td>second</td></tr></table><ul><li>Apples</li><li> Pears </li></ul><ol><li>1st</li></ol>`;
  assert.deepEqual(htmlTable(html, 1), [['Currency', 'Rate'], ['EUR', 0.92], ['Updated daily', 'Updated daily'], ['Nestedinner', 1]]);
  assert.deepEqual(htmlTable(html, 2), [['inner']], 'tables are counted in page order, nested ones too');
  assert.deepEqual(htmlTable(html, 3), [['second']]);
  assert.throws(() => htmlTable(html, 5), /has 3 tables/);
  assert.deepEqual(htmlList(html, 1), [['Apples'], ['Pears']]);
  assert.deepEqual(htmlList(html, 2), [['1st']]);
});

test('fetching: private addresses refused; redirects followed; size checked', async () => {
  await assert.rejects(fetchPage('http://127.0.0.1:9/x', { allowPrivate: false }), /private network/);
  await assert.rejects(fetchPage('http://localhost/x', { allowPrivate: false }), /private network/);
  await assert.rejects(fetchPage('file:///etc/passwd'), /Only http and https/);
  const srv = http.createServer((req, res) => {
    if (req.url === '/old') { res.writeHead(302, { location: '/data.csv' }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200); return res.end(Buffer.alloc(6 * 1024 * 1024, 97)); }
    res.writeHead(200, { 'content-type': 'text/csv' }); res.end('a,b\n1,2\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const got = await fetchPage(`${base}/old`, { allowPrivate: true });
  assert.deepEqual([got.text, got.type], ['a,b\n1,2\n', 'text/csv']);
  await assert.rejects(fetchPage(`${base}/big`, { allowPrivate: true }), /larger than 5 MB/);
});
