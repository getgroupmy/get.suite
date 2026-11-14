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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
const viewNow = () => page.getByRole('radiogroup', { name: 'View' }).locator('[aria-checked="true"]').innerText();
const heading = () => page.locator('.cal-head h1').innerText();
await step('W, D, M, Y and A switch the view; T comes back to today', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('radiogroup', { name: 'View' }).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  for (const [k, v] of [['w', 'Week'], ['d', 'Day'], ['y', 'Year'], ['a', 'Schedule'], ['m', 'Month']]) {
    await page.keyboard.press(k);
    await until(async () => (await viewNow()) === v);
  }
  const now = await heading();
  await page.keyboard.press('j');
  await until(async () => (await heading()) !== now);
  await page.keyboard.press('n');
  await page.keyboard.press('k');
  await page.keyboard.press('p');
  await until(async () => (await heading()) === now);
  await page.keyboard.press('j'); await page.keyboard.press('j');
  await until(async () => (await heading()) !== now);
  await page.keyboard.press('t');
  await until(async () => (await heading()) === now);
});
await step('C starts a new event; G then C still only goes to Calendar', async () => {
  await page.keyboard.press('c');
  await page.getByRole('dialog', { name: 'New event' }).waitFor();
  await page.keyboard.press('Escape');
  await until(async () => !(await page.getByRole('dialog').count()));
  await page.goto(`${B}/drive`);
  await page.locator('h1, .crumbs').first().waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('g'); await page.keyboard.press('c');
  await until(async () => /\/calendar/.test(page.url()));
  await page.getByRole('radiogroup', { name: 'View' }).waitFor();
  await page.waitForTimeout(500);
  if (await page.getByRole('dialog').count()) throw new Error('a new event opened too');
});
await step('the shortcut list has them; with single keys off, W does nothing', async () => {
  await page.keyboard.press('Control+/');
  await page.getByRole('dialog').getByText('Day, week, month, year or schedule view').waitFor();
  await axe(page, 'shortcut list');
  await page.keyboard.press('Escape');
  await api(page, 'PUT', '/users/me/keys', { on: false });
  await page.reload();
  await page.getByRole('radiogroup', { name: 'View' }).waitFor();
  await page.evaluate(() => document.activeElement?.blur());
  const before = await viewNow();
  await page.keyboard.press(before === 'Week' ? 'd' : 'w');
  await page.waitForTimeout(400);
  if ((await viewNow()) !== before) throw new Error('changed view');
  await api(page, 'PUT', '/users/me/keys', { on: true });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
