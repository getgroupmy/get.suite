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
const search = () => page.getByLabel('Search everything');
const tips = () => page.getByRole('group', { name: 'Tips' });
await step('"/" puts you in the search box; the empty box shows what you can type', async () => {
  await page.goto(`${B}/home`);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('/');
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search everything'));
  if (await search().inputValue() !== '') throw new Error('the / was typed');
  await tips().getByText('Type to make things').waitFor();
  const n = await tips().getByRole('option').count();
  if (n !== 5) throw new Error(`tips: ${n}`);
  await page.screenshot({ path: `${SP}/shots/search-tips.png` });
});
await step('picking a tip fills the box with it, and its action shows', async () => {
  await tips().getByRole('option', { name: /^task Send invoice friday !high/ }).click();
  if (await search().inputValue() !== 'task Send invoice friday !high') throw new Error(await search().inputValue());
  await page.getByRole('group', { name: 'Actions' }).getByText(/^Add task: Send invoice/).waitFor();
  if (await tips().count()) throw new Error('tips stay while typing');
  await page.mouse.move(5, 700); // away first: the tips come back under a resting mouse, which would pick one
  await search().fill('');
  await tips().waitFor();
  await page.mouse.move(5, 700); // not resting on a tip (hovering one picks it)
  await search().press('ArrowDown');
  await search().press('Enter');
  if (await search().inputValue() !== 'event Lunch tomorrow 1pm') throw new Error(`keyboard: ${await search().inputValue()}`);
});
await step('"/" in a text field is typed, not taken', async () => {
  await search().fill('');
  await page.goto(`${B}/notes`);
  await page.getByRole('button', { name: 'Take a note…' }).click();
  await page.waitForTimeout(300);
  await page.keyboard.type('a/b');
  const where = await page.evaluate(() => ({ label: document.activeElement?.getAttribute('aria-label'), value: document.activeElement?.value ?? document.activeElement?.textContent }));
  if (where.label === 'Search everything' || !String(where.value).includes('a/b')) throw new Error(JSON.stringify(where));
  await page.goto(`${B}/home`);
});
await step('Hide tips: gone everywhere (kept with the account); Settings brings them back', async () => {
  await search().click();
  await page.getByRole('button', { name: 'Hide tips' }).click();
  await page.getByText('Tips hidden: Settings → Search tips brings them back').waitFor();
  await tips().waitFor({ state: 'detached' });
  await page.reload();
  await search().click();
  await page.waitForTimeout(300);
  if (await tips().count()) throw new Error('back after reload');
  await page.goto(`${B}/settings`);
  const box = page.getByRole('checkbox', { name: /Show what I can type to make things/ });
  if (await box.isChecked()) throw new Error('setting says on');
  await box.check();
  await page.getByText('Search tips are on').waitFor();
  await search().click();
  await tips().waitFor();
});
await step('single-key shortcuts off: "/" does nothing', async () => {
  await api(page, 'PUT', '/users/me/keys', { on: false });
  await page.goto(`${B}/home`);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('/');
  await page.waitForTimeout(300);
  if (await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Search everything') throw new Error('still jumps');
  await api(page, 'PUT', '/users/me/keys', { on: true });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
