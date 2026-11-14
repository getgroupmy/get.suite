import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
// A 400 × 200 PNG made in the page (red left half, blue right): the photo keeps the middle square.
const makePng = () => page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 400; c.height = 200;
  const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0, 0, 200, 200); x.fillStyle = '#00f'; x.fillRect(200, 0, 200, 200);
  const b = await new Promise((r) => c.toBlob(r, 'image/png'));
  return Array.from(new Uint8Array(await b.arrayBuffer()));
});
await step('a new contact with a photo: it shows in the list', async () => {
  const png = Buffer.from(await makePng());
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'New contact' }).click();
  const d = page.getByRole('dialog', { name: 'New contact' });
  await d.getByLabel('Name').fill('Rosa Diaz');
  await d.getByLabel('Photo').setInputFiles({ name: 'rosa.png', mimeType: 'image/png', buffer: png });
  await d.getByRole('button', { name: 'Change photo' }).waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  const img = page.locator('tr', { hasText: 'Rosa Diaz' }).locator('img.avatar');
  await img.waitFor();
  await until(() => img.evaluate((i) => i.complete && i.naturalWidth === 200));
  const c = (await api(page, 'GET', '/contacts')).body.find((x) => x.name === 'Rosa Diaz');
  const type = await page.evaluate(async (id) => (await fetch(`/api/contacts/${id}/photo`)).headers.get('content-type'), c.id);
  if (type !== 'image/jpeg') throw new Error(type);
  await page.screenshot({ path: `${SP}/shots/contactphoto.png` });
});
await step('remove the photo: initials come back', async () => {
  await page.getByRole('button', { name: 'Edit Rosa Diaz' }).click();
  const d = page.getByRole('dialog', { name: 'Edit contact' });
  await d.getByRole('button', { name: 'Remove photo' }).click();
  await d.getByRole('button', { name: 'Add photo' }).waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await until(async () => (await page.locator('tr', { hasText: 'Rosa Diaz' }).locator('img.avatar').count()) === 0);
  await page.locator('tr', { hasText: 'Rosa Diaz' }).getByText('RD').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
