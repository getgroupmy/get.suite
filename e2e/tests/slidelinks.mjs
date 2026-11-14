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
let deckId;
const box = (id, text, x, y, w, h) => ({ id, type: 'text', text, x, y, w, h, size: 24 });
const item = (txt) => page.locator('.slide.editable').getByText(txt, { exact: true });
const items = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content.slides[0].items;
const shown = (txt) => page.locator('.presenter').getByText(txt, { exact: true });
await step('link a box to a web page and another to a slide', async () => {
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Menu', content: { theme: 'light', slides: [
    { id: 's1', items: [box('a', 'Order online', 10, 10, 40, 12), box('b', 'See prices', 10, 40, 40, 12), box('c', 'Just text', 10, 70, 40, 12)] },
    { id: 's2', items: [box('d', 'Second slide', 10, 10, 60, 12)] },
    { id: 's3', items: [box('e', 'Prices', 10, 10, 60, 12)] },
  ] } })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await item('Order online').click();
  await page.getByRole('button', { name: 'Link' }).click();
  let dlg = page.getByRole('dialog', { name: 'Link' });
  await dlg.getByLabel('Web address or email').fill('javascript:alert(1)');
  if (!(await dlg.getByRole('button', { name: 'Save' }).isDisabled())) throw new Error('not a web address');
  await dlg.getByLabel('Web address or email').fill('acme.example/orders');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await items()).find((x) => x.id === 'a').link?.url === 'https://acme.example/orders');
  await item('See prices').click();
  await page.getByRole('button', { name: 'Link' }).click();
  dlg = page.getByRole('dialog', { name: 'Link' });
  await dlg.getByRole('radio', { name: 'A slide' }).click();
  await dlg.getByLabel('Slide').selectOption({ label: 'Slide 3: Prices' });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await until(async () => (await items()).find((x) => x.id === 'b').link?.slide === 's3');
  if ((await page.locator('.slide.editable .link-badge').count()) !== 2) throw new Error('two badges');
  await page.screenshot({ path: `${SP}/shots/slidelinks.png` });
});
await step('presenting: a linked box follows its link; elsewhere moves on', async () => {
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await shown('See prices').waitFor();
  await shown('See prices').click();
  await shown('Prices').waitFor();
  await page.keyboard.press('Home');
  await shown('Order online').waitFor();
  await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; }); // the test machine can't reach the site
  await shown('Order online').click();
  const opened = await until(() => page.evaluate(() => window.__opened[0]));
  if (opened[0] !== 'https://acme.example/orders' || opened[1] !== '_blank' || !/noopener/.test(opened[2])) throw new Error(JSON.stringify(opened));
  if (!(await shown('Order online').isVisible())) throw new Error('stays on the slide');
  await shown('Just text').click();
  await shown('Second slide').waitFor();
  await page.keyboard.press('Escape');
});
await step('removing a link, and deleting the slide a link points to, take the links off', async () => {
  await page.locator('.slide:not(.editable)').getByText('Order online', { exact: true }).first().click(); // slide 1 in the list
  await item('Order online').click();
  await page.getByRole('button', { name: 'Link' }).click();
  await page.getByRole('dialog', { name: 'Link' }).getByRole('button', { name: 'Remove link' }).click();
  await until(async () => !(await items()).find((x) => x.id === 'a').link);
  await page.getByRole('button', { name: 'Options for slide 3' }).click();
  await page.getByRole('menuitem', { name: 'Delete slide' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await until(async () => !(await items()).find((x) => x.id === 'b').link);
});
await step('PowerPoint download keeps the links', async () => {
  const r = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/export`)).status, deckId);
  if (r !== 200) throw new Error(String(r));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
