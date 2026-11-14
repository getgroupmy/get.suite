import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-49]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let sheetId;
const cell = (k) => page.locator(`[data-k="${k}"]`);
const typeIn = async (k, text) => { await cell(k).click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const cells = { A1: 'Prices' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells }] } })).body.id;
  await page.goto(`${B}/sheets/${sheetId}`);
  await cell('A1').getByText('Prices').waitFor();
});
const http = await import('node:http');
const site = http.createServer((req, res) => {
  if (req.url === '/prices.csv') { res.writeHead(200, { 'content-type': 'text/csv' }); return res.end('Item,Price\nTea,3.5\n"Cake, lemon",4\n'); }
  if (req.url === '/rates') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Rates</h1><table><tr><th>Currency</th><th>Rate</th></tr><tr><td>EUR</td><td>0.92</td></tr><tr><td>GBP</td><td>0.79</td></tr></table><ul><li>Updated daily</li></ul>'); }
  if (req.url === '/feed') { res.writeHead(200, { 'content-type': 'application/rss+xml' }); return res.end('<rss version="2.0"><channel><title>Acme news</title><link>https://acme.example</link><item><title>Spring opening</title><link>https://acme.example/1</link><pubDate>Mon, 09 Nov 2026 08:00:00 GMT</pubDate></item><item><title>New hours</title><link>https://acme.example/2</link></item></channel></rss>'); }
  res.writeHead(404); res.end();
});
await new Promise((r) => site.listen(8097, '127.0.0.1', r));
await step('IMPORTDATA brings in a CSV file from the web', async () => {
  await typeIn('A2', '=IMPORTDATA("http://127.0.0.1:8097/prices.csv")');
  await cell('A4').getByText('Cake, lemon').waitFor({ timeout: 20000 });
  const got = [];
  for (const k of ['A2', 'B2', 'A3', 'B3', 'B4']) got.push((await cell(k).innerText()).trim());
  if (got.join('|') !== 'Item|Price|Tea|3.5|4') throw new Error(got.join('|'));
});
await step('IMPORTHTML brings in a table from a web page, and a sum works on it', async () => {
  await typeIn('D1', '=IMPORTHTML("http://127.0.0.1:8097/rates", "table", 1)');
  await cell('D3').getByText('GBP').waitFor({ timeout: 20000 });
  await typeIn('G1', '=SUM(IMPORTHTML("http://127.0.0.1:8097/rates", "table", 1))');
  await until(async () => (await cell('G1').innerText()).trim() === '1.71');
  await page.screenshot({ path: `${SP}/shots/webimport.png` });
});
await step('IMPORTFEED lists a news feed\'s items, with a heading row', async () => {
  await typeIn('I1', '=IMPORTFEED("http://127.0.0.1:8097/feed", "items title", TRUE)');
  await cell('I3').getByText('New hours').waitFor({ timeout: 20000 });
  if ((await cell('I1').innerText()).trim() !== 'Title' || (await cell('I2').innerText()).trim() !== 'Spring opening') throw new Error('rows');
});
await step('a page that isn\'t there says why', async () => {
  await typeIn('G3', '=IMPORTDATA("http://127.0.0.1:8097/missing.csv")');
  await cell('G3').getByText('#N/A').waitFor({ timeout: 20000 });
  await cell('G3').click();
  await page.getByText('The page answered 404').waitFor();
});
site.close();
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
