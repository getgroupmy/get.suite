import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
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
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
const shot = async (name, url) => {
  await page.goto(`${B}${url}`);
  await page.waitForTimeout(1500);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log('DBG', name, 'overflow', over);
  await page.screenshot({ path: `${SP}/shots/m-${name}.png` });
};
const noSideScroll = async (where) => { const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (over > 2) throw new Error(`${where}: ${over}px wider than the screen`); };
const fits = async (loc, where) => { const b = await loc.boundingBox(); if (!b || b.x < -1 || b.x + b.width > 391) throw new Error(`${where}: ${JSON.stringify(b)}`); };
await step('chat on a phone: the message box is there and sends', async () => {
  await page.goto(`${B}/chat`);
  const box = page.getByRole('textbox', { name: /Message/ }).first();
  await box.waitFor();
  const b = await box.boundingBox();
  if (!b || b.width < 250) throw new Error(`message box ${JSON.stringify(b)}`);
  await box.fill('Hello from my phone');
  await box.press('Enter');
  const msg = page.locator('.msg', { hasText: 'Hello from my phone' });
  await msg.waitFor();
  const tb = await msg.locator('.msg-body').boundingBox();
  if (tb.width < 200) throw new Error(`message squeezed to ${tb.width}px`);
  if (await msg.locator('.msg-actions').isVisible()) throw new Error('actions shown before tapping');
  await msg.locator('.msg-body').tap();
  await msg.locator('.msg-actions').waitFor();
  await noSideScroll('chat');
  await page.screenshot({ path: `${SP}/shots/m-chat2.png` });
});
await step('a new document on a phone: the editor fits', async () => {
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Phone notes' })).body;
  await page.goto(`${B}/docs/${d.id}`);
  const ed = page.locator('.ProseMirror').first();
  await ed.waitFor();
  await ed.click();
  await page.keyboard.type('Typed on a phone');
  await page.getByText('Typed on a phone').waitFor();
  // The formatting toolbar is folded away; unfolded, bold works on the selection.
  const tb = page.getByRole('toolbar', { name: 'Formatting' });
  if ((await tb.boundingBox()).height > 60) throw new Error('toolbar not folded');
  if (await tb.getByRole('button', { name: 'Bold (Ctrl+B)' }).isVisible()) throw new Error('tools showing while folded');
  await tb.getByRole('button', { name: 'Formatting ▾' }).click();
  await page.keyboard.press('Control+a');
  await tb.getByRole('button', { name: 'Bold (Ctrl+B)' }).click();
  await page.locator('.ProseMirror strong', { hasText: 'Typed on a phone' }).waitFor();
  await tb.getByRole('button', { name: 'Hide formatting ▴' }).click();
  await noSideScroll('docs');
  await fits(ed, 'docs editor');
  await page.screenshot({ path: `${SP}/shots/m-doc.png` });
});
await step('a new event on a phone: the window fits the screen', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.waitFor();
  await fits(dlg, 'event window');
  await dlg.getByLabel('Title').fill('Site visit');
  await dlg.getByRole('button', { name: 'Save' }).scrollIntoViewIfNeeded();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.screenshot({ path: `${SP}/shots/m-cal2.png` });
});
await step('Drive on a phone: the New menu fits', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const menu = page.getByRole('menu');
  await menu.waitFor();
  await fits(menu, 'New menu');
  await page.keyboard.press('Escape');
});
await step('screens', async () => {
  for (const [n, u] of [['home', '/'], ['mail', '/mail'], ['drive', '/drive'], ['calendar', '/calendar'], ['chat', '/chat'], ['tasks', '/tasks'], ['contacts', '/contacts'], ['admin', '/admin']]) await shot(n, u);
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
