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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
const tomorrowAt = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.getTime(); };
const dayIso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
await step('the admin imports rooms from a CSV file', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click().catch(() => page.getByRole('button', { name: 'Company settings' }).click());
  await page.getByLabel('Rooms file to import').setInputFiles(`${ROOT}/e2e/fixtures/rooms.csv`);
  await page.getByText('2 added, 0 updated · Line 4: no name').waitFor();
  const list = page.getByRole('list', { name: 'Rooms' });
  await list.getByLabel('Name of Boardroom').waitFor();
  if ((await list.getByLabel('Equipment in Boardroom').inputValue()) !== 'Video, Whiteboard') throw new Error('equipment');
  if ((await list.getByLabel('Where Huddle is').inputValue()) !== 'Ground floor') throw new Error('where');
  if (!(await list.getByLabel('Only admins can book Boardroom').isChecked()) || await list.getByLabel('Only admins can book Huddle').isChecked()) throw new Error('admins only');
  if (!(await list.getByLabel('Release Huddle if nobody checks in').isChecked())) throw new Error('check-in');
  await page.getByRole('list', { name: 'Rooms' }).screenshot({ path: `${SP}/shots/roomcsv.png` });
});
await step('Export as CSV gives them back', async () => {
  const dl = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export as CSV' }).click();
  const text = await (await (await dl).createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  if (!text.includes('Boardroom,12,2nd floor,"Video, Whiteboard",yes,no') || !text.includes('Huddle,4,Ground floor,Video,no,yes')) throw new Error(text);
});
await step('Open in Sheets: the rooms as a spreadsheet in Drive, the same columns', async () => {
  await page.getByRole('button', { name: 'Open in Sheets' }).click();
  await page.locator('.toast', { hasText: 'Made “Rooms” in your Drive' }).getByRole('button', { name: 'Open' }).click();
  await page.waitForURL(/\/sheets\//);
  await page.locator('[data-k="A1"]', { hasText: 'Name' }).waitFor();
  await page.locator('[data-k="F1"]', { hasText: 'Check-in' }).waitFor();
  await page.getByText('Boardroom', { exact: true }).first().waitFor();
  await page.getByText('Video, Whiteboard', { exact: true }).first().waitFor();
});
await step('changed in Sheets, then ⋮ → Update company rooms: the change is in Admin (no CSV in between)', async () => {
  // (the sheet from the step before: Boardroom is row 2, sorted by name)
  await page.locator('[data-k="A2"]', { hasText: 'Boardroom' }).waitFor();
  await page.locator('[data-k="B2"]').click();
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await page.locator('[data-k="B2"]', { hasText: '20' }).waitFor();
  const seats = async () => (await api(page, 'GET', '/rooms')).body.find((r) => r.name === 'Boardroom')?.capacity;
  for (let i = 0; i < 6 && (await seats()) !== 20; i++) { // (the edit is saved a moment after it's typed)
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Update company rooms' }).click();
    await page.locator('.toast', { hasText: /^Rooms: 0 added, \d+ updated/ }).last().waitFor();
  }
  if ((await seats()) !== 20) throw new Error(`Boardroom has ${await seats()} seats`);
});
await step('Admin → Rooms → Import from Sheets…: a spreadsheet in Drive read like the CSV', async () => {
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Rooms upstairs', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Name', B1: 'Seats', C1: 'Where', A2: 'Loft', B2: '8', C2: '3rd floor' } }] } });
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click().catch(() => page.getByRole('button', { name: 'Company settings' }).click());
  await page.getByRole('button', { name: 'Import from Sheets…' }).click();
  const pick = page.getByRole('dialog', { name: 'Import rooms from a spreadsheet' });
  await pick.getByLabel('Search your files').fill('Rooms upstairs');
  await pick.getByRole('button', { name: /Rooms upstairs/ }).click();
  await page.getByText('1 added, 0 updated').waitFor();
  const loft = (await api(page, 'GET', '/rooms')).body.find((r) => r.name === 'Loft');
  if (loft?.capacity !== 8 || loft.location !== '3rd floor') throw new Error(JSON.stringify(loft));
});
console.log(errors.length ? `ERRORS ${errors.join(' / ')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
