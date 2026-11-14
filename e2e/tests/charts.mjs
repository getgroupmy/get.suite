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
let sheetId, kim, vic;
const content = () => api(page, 'GET', `/files/${sheetId}/content`).then((r) => r.body.content);

await step('setup: a spreadsheet with figures, shared with an editor and a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [local, name] of [['kim', 'Kim Park'], ['vic', 'Vic Viewer']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const idOf = (e) => dir.find((u) => u.username === e).id;
  const cells = { A1: 'Month', B1: 'Sales', C1: 'Costs', A2: 'Jan', B2: '10', C2: '4', A3: 'Feb', B3: '12', C3: '5', A4: 'Mar', B4: '9', C4: '7', A5: 'Apr', B5: '15', C5: '6' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers', content: { sheets: [{ name: 'Sheet1', cells, colWidths: {} }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: idOf('kim@acme.com'), role: 'editor' }, { user_id: idOf('vic@acme.com'), role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/sheets/${sheetId}`); await p.locator('[data-k="B5"]', { hasText: '15' }).waitFor(); }
});

await step('insert a chart of the data around the selected cell, with a preview', async () => {
  await page.locator('[data-k="B3"]').click();
  await page.getByRole('button', { name: 'Insert chart' }).click();
  const dlg = page.getByRole('dialog', { name: 'Insert chart' });
  if (await dlg.getByLabel('Cells').inputValue() !== 'A1:C5') throw new Error('range ' + await dlg.getByLabel('Cells').inputValue());
  await dlg.getByLabel('Preview').getByRole('list', { name: 'Legend' }).getByText('Costs').waitFor();
  if (await dlg.locator('.chart-preview svg path').count() !== 8) throw new Error('bars in preview');
  await dlg.getByLabel('Title').fill('Sales and costs');
  await dlg.getByRole('button', { name: 'Insert' }).click();
  await page.getByRole('region', { name: 'Chart: Sales and costs' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/chart-column.png` });
});

await step('others see it live; viewers cannot change it', async () => {
  for (const p of [kim, vic]) await p.getByRole('region', { name: 'Chart: Sales and costs' }).locator('svg path').nth(7).waitFor();
  await vic.getByRole('button', { name: /^Options for chart/ }).click(); // viewers: only the picture
  const items = await vic.getByRole('menuitem').allInnerTexts();
  if (items.join('|') !== 'Download as a picture (.png)') throw new Error(`viewer's menu: ${items.join('|')}`);
  await vic.keyboard.press('Escape');
  await until(async () => Object.values((await content()).sheets[0].charts || {})[0]?.range === 'A1:C5', 6000);
});

await step('hovering a column shows its numbers', async () => {
  const card = page.getByRole('region', { name: 'Chart: Sales and costs' });
  const box = await card.locator('svg').boundingBox();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5); // over Feb (2nd of 4)
  await card.locator('.chart-tip', { hasText: 'Feb' }).getByText('Sales: 12').waitFor();
});

await step('the chart follows the cells', async () => {
  await page.locator('[data-k="B2"]').click();
  await page.keyboard.type('50');
  await page.keyboard.press('Enter');
  const card = kim.getByRole('region', { name: 'Chart: Sales and costs' });
  await card.getByRole('button', { name: 'Show data' }).click();
  await card.locator('.chart-table tr', { hasText: 'Jan' }).getByText('50').waitFor();
  await card.getByRole('button', { name: 'Show chart' }).click();
});

await step('drag to move and resize; it moves for the others too', async () => {
  const card = page.getByRole('region', { name: 'Chart: Sales and costs' });
  const b = await card.boundingBox();
  await page.mouse.move(b.x + 60, b.y + 18); await page.mouse.down(); await page.mouse.move(b.x + 160, b.y + 98, { steps: 5 }); await page.mouse.up();
  const r = await card.locator('.chart-resize').boundingBox();
  await page.mouse.move(r.x + 8, r.y + 8); await page.mouse.down(); await page.mouse.move(r.x + 108, r.y + 58, { steps: 5 }); await page.mouse.up();
  const kb = kim.getByRole('region', { name: 'Chart: Sales and costs' });
  await until(async () => { const s = await kb.evaluate((el) => [el.style.left, el.style.width, el.style.height]); return s[1] === '580px' && s[2] === '350px'; });
  await until(async () => { const ch = Object.values((await content()).sheets[0].charts)[0]; return ch.w === 580 && ch.h === 350 && ch.x > 400; }, 8000);
});

await step('edit: a line chart, then a pie with shares in the legend', async () => {
  await page.getByRole('button', { name: 'Options for chart Sales and costs' }).click();
  await page.getByRole('menuitem', { name: 'Edit chart' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit chart' });
  await dlg.getByText('Line', { exact: true }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await kim.getByRole('region', { name: 'Chart: Sales and costs' }).locator('polyline').nth(1).waitFor();
  await page.screenshot({ path: `${SP}/shots/chart-line.png` });
  await page.getByRole('region', { name: 'Chart: Sales and costs' }).dblclick({ position: { x: 100, y: 18 } });
  await page.getByRole('dialog', { name: 'Edit chart' }).getByText('Pie', { exact: true }).click();
  await page.getByRole('dialog', { name: 'Edit chart' }).getByRole('button', { name: 'Save' }).click();
  await kim.getByRole('region', { name: 'Chart: Sales and costs' }).getByRole('list', { name: 'Legend' }).getByText('Jan · 58%').waitFor(); // 50 of 86
  await page.screenshot({ path: `${SP}/shots/chart-pie.png` });
});

await step('bad cells are refused', async () => {
  await page.getByRole('button', { name: 'Insert chart' }).click();
  const dlg = page.getByRole('dialog', { name: 'Insert chart' });
  await dlg.getByLabel('Cells').fill('A1');
  await dlg.getByText('There are no numbers in these cells').waitFor();
  if (await dlg.getByRole('button', { name: 'Insert' }).isEnabled()) throw new Error('enabled');
  await dlg.getByLabel('Cells').fill('nonsense');
  await dlg.getByText('Choose cells like A1:C10').waitFor();
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

await step('charts survive a reload, and are deleted for everyone', async () => {
  await kim.reload();
  await kim.getByRole('region', { name: 'Chart: Sales and costs' }).waitFor();
  await page.getByRole('button', { name: 'Options for chart Sales and costs' }).click();
  await page.getByRole('menuitem', { name: 'Delete chart' }).click();
  await until(async () => (await kim.getByRole('region', { name: /^Chart:/ }).count()) === 0);
});

await step('dark mode', async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('[data-k="A1"]').click();
  await page.getByRole('button', { name: 'Insert chart' }).click();
  await page.getByRole('dialog', { name: 'Insert chart' }).getByRole('button', { name: 'Insert' }).click();
  await page.getByRole('region', { name: 'Chart: Untitled' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/chart-dark.png` });
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
