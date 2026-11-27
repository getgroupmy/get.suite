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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const upload = (p, name, text, parent) => p.evaluate(async ([n, t, pa]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}${pa ? `&parent=${pa}` : ''}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json(), [name, text, parent]);
const cellsOf = (t) => t.locator('tbody tr').evaluateAll((rows) => rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent)));
let csv;
await step('a CSV in Drive opens as a table: headings, rows, quoted commas and line breaks kept in their cells', async () => {
  csv = await upload(page, 'stock.csv', 'Item,Note,Price\r\n"Oak desk","Big, heavy",120\r\n"Chair ""Ola""","two\nlines",40\r\n');
  await page.goto(`${B}/drive`);
  await page.locator('.files tbody tr').filter({ hasText: 'stock.csv' }).getByText('stock.csv').dblclick();
  const t = page.getByRole('region', { name: 'Table of stock.csv' });
  await t.waitFor({ timeout: 15000 });
  const heads = await t.locator('thead th').allInnerTexts();
  if (heads.slice(1).join('|') !== 'Item|Note|Price') throw new Error(heads.join('|'));
  const cells = await cellsOf(t);
  if (JSON.stringify(cells) !== JSON.stringify([['Oak desk', 'Big, heavy', '120'], ['Chair "Ola"', 'two\nlines', '40']])) throw new Error(JSON.stringify(cells));
  await page.getByText('2 rows · 3 columns').waitFor();
  await page.screenshot({ path: `${SP}/shots/table-csv.png` });
  await page.getByRole('button', { name: 'Show as text' }).click();
  await page.getByLabel('Text of stock.csv').getByText('"Big, heavy"').waitFor();
  await page.getByRole('button', { name: 'Show as a table' }).click();
  await t.waitFor();
});
await step('a big file: the headings stay in view while scrolling, and it says only the first 1,000 rows are shown', async () => {
  const rows = ['Id;City;Amount', ...Array.from({ length: 1500 }, (_, i) => `${i};Lyon;${i * 2}`)].join('\n'); // ; as Excel writes in France
  await upload(page, 'ventes.csv', rows);
  await page.keyboard.press('Escape');
  await page.goto(`${B}/drive`);
  await page.locator('.files tbody tr').filter({ hasText: 'ventes.csv' }).getByText('ventes.csv').dblclick();
  const t = page.getByRole('region', { name: 'Table of ventes.csv' });
  await t.waitFor({ timeout: 15000 });
  await page.getByText(/1,000 rows · 3 columns · only the first 1,000 are shown/).waitFor();
  if ((await t.locator('thead th').allInnerTexts()).slice(1).join('|') !== 'Id|City|Amount') throw new Error('semicolons not split');
  await t.evaluate((el) => { el.scrollTop = 5000; });
  const headTop = await t.evaluate((el) => el.querySelector('thead th:nth-child(2)').getBoundingClientRect().top - el.getBoundingClientRect().top);
  if (Math.abs(headTop) > 3) throw new Error(`heading row moved ${headTop}px`);
  await page.keyboard.press('Escape');
});
await step('the table passes an accessibility check and fits a phone screen', async () => {
  await page.locator('.files tbody tr').filter({ hasText: 'stock.csv' }).getByText('stock.csv').dblclick();
  await page.getByRole('region', { name: 'Table of stock.csv' }).waitFor({ timeout: 15000 });
  await page.evaluate(AXE);
  const v = await page.evaluate(async () => (await window.axe.run(document.querySelector('[role=dialog]'), { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`));
  if (v.length) throw new Error(v.join(' | '));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.setViewportSize({ width: 1280, height: 900 });
  if (w > 392) throw new Error(`page is ${w}px wide`);
  await page.keyboard.press('Escape');
});
await step('a view-only CSV (downloading off), a TSV sent in Chat and a TSV on a public link all open as tables', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  await api(page, 'PUT', `/files/${csv.id}/shares`, { shares: [{ user_id: kim.id, role: 'viewer' }] });
  await api(page, 'PATCH', `/files/${csv.id}`, { no_download: true });
  const k = await mk('kim');
  await k.goto(B);
  await k.getByLabel('Email address').fill('kim@acme.com');
  await k.getByLabel('Password').fill('password123');
  await k.getByRole('button', { name: 'Sign in' }).click();
  await k.getByRole('link', { name: 'Drive' }).first().waitFor();
  await k.goto(`${B}/drive?preview=${csv.id}`);
  await k.getByRole('region', { name: 'Table of stock.csv' }).getByText('Big, heavy').waitFor({ timeout: 15000 });
  // Chat
  const dm = (await api(k, 'POST', '/chat/dm', { user_id: (await api(page, 'GET', '/auth/me')).body.user.id })).body.id;
  const tsv = await upload(k, 'rota.tsv', 'Day\tWho\nMon\tKim\nTue\tOlivia\n');
  await api(k, 'POST', `/chat/channels/${dm}/messages`, { body: 'Rota', files: [tsv.id] });
  await page.goto(`${B}/chat/${dm}`);
  await page.getByRole('link', { name: /rota\.tsv/ }).click({ timeout: 15000 });
  const ct = page.getByRole('dialog', { name: 'rota.tsv' }).getByRole('region', { name: 'Table of rota.tsv' });
  await ct.waitFor({ timeout: 15000 });
  if (JSON.stringify(await cellsOf(ct)) !== JSON.stringify([['Mon', 'Kim'], ['Tue', 'Olivia']])) throw new Error(JSON.stringify(await cellsOf(ct)));
  await page.keyboard.press('Escape');
  // A public link
  const own = await upload(page, 'prices.tsv', 'Item\tPrice\nLamp\t25\n');
  const l = (await api(page, 'POST', '/links', { file_id: own.id })).body;
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const v = await vctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(`${B}/s/${l.token}`);
  await v.getByRole('region', { name: 'Table of prices.tsv' }).getByText('Lamp').waitFor({ timeout: 15000 });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
