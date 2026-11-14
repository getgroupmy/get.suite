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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
let sheet;
await step('two people change a cell over time; its edit history lists each change with who and the value before', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget' })).body;
  const dir = (await api(page, 'GET', '/users/directory')).body;
  await api(page, 'PUT', `/files/${sheet.id}/shares`, { shares: [{ user_id: dir.find((x) => x.username === 'kim@acme.com').id, role: 'editor' }] });
  const kctx = await browser.newContext(); const k = await kctx.newPage();
  await k.goto(B); await k.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  const put = async (p, cells) => { const c = (await api(p, 'GET', `/files/${sheet.id}/content`)).body; await api(p, 'PUT', `/files/${sheet.id}/content`, { version: c.file.version, content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells }] } }); };
  await put(page, { A4: 'Total', B4: '100' });
  await put(k, { A4: 'Total', B4: '120' });
  await put(page, { A4: 'Total', B4: '135' });
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('B4').filter({ hasText: '135' }).waitFor();
  await cell('B4').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show edit history' }).click();
  const d = page.getByRole('dialog', { name: 'Edit history of B4' });
  const items = d.getByRole('list', { name: 'Changes to B4' }).getByRole('listitem');
  await items.first().waitFor();
  const texts = await items.allInnerTexts();
  if (texts.length !== 3 || !/135[\s\S]*now[\s\S]*Olivia Owner[\s\S]*was\s*120/.test(texts[0]) || !/120[\s\S]*Kim Park[\s\S]*was\s*100/.test(texts[1]) || !/100[\s\S]*Olivia Owner/.test(texts[2])) throw new Error(JSON.stringify(texts));
  await page.screenshot({ path: `${SP}/shots/cellhistory.png` });
});
await step('Use this value puts an earlier value back', async () => {
  const d = page.getByRole('dialog', { name: 'Edit history of B4' });
  await d.getByRole('listitem').nth(2).getByRole('button', { name: 'Use this value' }).click();
  await page.getByText('B4 changed back').waitFor();
  await cell('B4').filter({ hasText: /^100$/ }).waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
