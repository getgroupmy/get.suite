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
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
});
await step('comment threads in an Excel file open on their cells', async () => {
  const b64 = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/office/xlcm.xlsx`).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Prices.xlsx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  await page.goto(`${B}/sheets/${opened.body.id}`);
  const b2 = page.locator('[data-k="B2"]');
  await b2.getByText('4').waitFor();
  await until(async () => (await b2.getAttribute('class')).includes('commented'));
  if ((await b2.getAttribute('title')) && /Threaded comment/.test(await b2.getAttribute('title'))) throw new Error('the old-style note came in');
  await b2.click();
  await page.getByText(/^Is this the final price\?/).first().waitFor();
  await page.getByText('— Raj & Co (in the Excel file)').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/xlsx-comments.png` });
  sheetId = opened.body.id;
});
await step('the .ods download keeps the cell comment threads with their replies; reopened, they are threads on the same cells', async () => {
  const threads = (await api(page, 'GET', `/comments/${sheetId}`)).body;
  const root = threads.find((c) => !c.thread_id && c.body.startsWith('Is this the final price?'));
  if ((await api(page, 'POST', `/comments/${sheetId}`, { body: 'Yes, from Monday.', thread_id: root.id })).status !== 201) throw new Error('reply');
  const up = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=ods`)).arrayBuffer();
    return (await fetch('/api/files/upload?name=Prices.ods', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
  }, sheetId);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  const back = (await api(page, 'GET', `/comments/${opened.body.id}`)).body;
  const r2 = back.find((c) => !c.thread_id && c.body.startsWith('Is this the final price?'));
  if (!r2 || !/\(in the OpenDocument file\)$/.test(r2.body)) throw new Error(JSON.stringify(back.map((c) => c.body)));
  const anchor = typeof r2.anchor === 'string' ? JSON.parse(r2.anchor) : r2.anchor;
  if (anchor?.cell !== 'B2') throw new Error('on B2: ' + JSON.stringify(r2.anchor));
  if (!back.some((c) => c.thread_id === r2.id && c.body.startsWith('Yes, from Monday.'))) throw new Error('reply ' + JSON.stringify(back.map((c) => [c.thread_id, c.body])));
  const content = (await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content;
  if (content.sheets[0].notes?.B2) throw new Error('the thread came in as a note too');
  await page.goto(`${B}/sheets/${opened.body.id}`);
  const b2 = page.locator('[data-k="B2"]');
  await until(async () => (await b2.getAttribute('class')).includes('commented'));
  await b2.click();
  await page.getByText(/^Yes, from Monday\./).first().waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
