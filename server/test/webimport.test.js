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

test('IMPORTFEED: RSS and Atom items, one field, the feed itself, headers and how many', async () => {
  const { feedRows } = await import('../src/routes/webimport.js');
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Acme news</title><link>https://acme.com</link><description>From the shop</description>
    <item><title>Spring opening</title><link>https://acme.com/1</link><pubDate>Mon, 09 Nov 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>Doors open at <b>9</b></p>]]></description></item>
    <item><title>New hours</title><link>https://acme.com/2</link><pubDate>Tue, 10 Nov 2026 08:00:00 GMT</pubDate><description>Later on Fridays</description></item></channel></rss>`;
  assert.deepEqual(feedRows(rss), [['Spring opening', 'https://acme.com/1', '2026-11-09 08:00', 'Doors open at 9'], ['New hours', 'https://acme.com/2', '2026-11-10 08:00', 'Later on Fridays']]);
  assert.deepEqual(feedRows(rss, { query: 'items title', headers: true, num: 1 }), [['Title'], ['Spring opening']]);
  assert.deepEqual(feedRows(rss, { query: 'feed' }), [['Acme news', 'https://acme.com', 'From the shop']]);
  assert.deepEqual(feedRows(rss, { query: 'feed title' }), [['Acme news']]);
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><link href="https://blog.example/"/><entry><title>Hello</title><link href="https://blog.example/hello"/><updated>2026-11-01T10:30:00Z</updated><summary>First post</summary><author><name>Kim</name></author></entry></feed>`;
  assert.deepEqual(feedRows(atom, { headers: true }), [['Title', 'URL', 'Date Created', 'Summary'], ['Hello', 'https://blog.example/hello', '2026-11-01 10:30', 'First post']]);
  assert.deepEqual(feedRows(atom, { query: 'items author' }), [['Kim']]);
  assert.throws(() => feedRows('<html><body>x</body></html>'), /isn't an RSS or Atom feed/);
  assert.throws(() => feedRows(rss, { query: 'items colour' }), /IMPORTFEED/);
});
