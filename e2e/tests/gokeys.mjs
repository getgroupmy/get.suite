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
const body = () => page.locator('body').click({ position: { x: 5, y: 600 } });
await step('G then a letter goes to that app; ? lists them under Everywhere', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await body();
  await page.keyboard.press('g'); await page.keyboard.press('c');
  await page.waitForURL('**/calendar');
  await body();
  await page.keyboard.press('g'); await page.keyboard.press('t');
  await page.waitForURL('**/tasks');
  await body();
  await page.keyboard.press('g'); await page.keyboard.press('s');
  await page.waitForURL('**/settings');
  // Typing a G in a box is just a G.
  await page.getByRole('combobox', { name: 'Search everything' }).fill('');
  await page.getByRole('combobox', { name: 'Search everything' }).pressSequentially('gd');
  if (!page.url().endsWith('/settings')) throw new Error('moved while typing');
  await page.keyboard.press('Escape');
  await body();
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await help.getByText('G then M').waitFor();
  await help.getByText('Go to Mail').waitFor();
  await page.screenshot({ path: `${SP}/shots/gokeys-help.png` });
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'detached' });
});
await step('Settings: single-key shortcuts off; G and ? do nothing, Ctrl+/ still lists them; kept after reloading', async () => {
  await page.goto(`${B}/settings`);
  const box = page.getByRole('checkbox', { name: /Single-key shortcuts/ });
  await box.uncheck();
  await page.getByText('Single-key shortcuts are off').waitFor();
  await page.reload();
  await page.getByRole('checkbox', { name: /Single-key shortcuts/ }).waitFor();
  if (await page.getByRole('checkbox', { name: /Single-key shortcuts/ }).isChecked()) throw new Error('not kept');
  await body();
  await page.keyboard.press('g'); await page.keyboard.press('d');
  await page.waitForTimeout(500);
  if (!page.url().endsWith('/settings')) throw new Error('went somewhere');
  await page.keyboard.press('?');
  await page.waitForTimeout(300);
  if (await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).count()) throw new Error('? opened the list');
  await page.keyboard.press('Control+/');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('checkbox', { name: /Single-key shortcuts/ }).check();
  await page.getByText('Single-key shortcuts are on').waitFor();
  await body();
  await page.keyboard.press('g'); await page.keyboard.press('h');
  await page.waitForURL('**/home');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
