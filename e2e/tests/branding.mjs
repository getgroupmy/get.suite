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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
const accent = (p) => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
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
await step('upload a logo and pick a colour: the app takes them at once', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click();
  await page.locator('input[aria-label="Logo file"]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await page.locator('.toast', { hasText: 'Logo saved' }).waitFor();
  await page.locator('.topbar .brand-logo, header .brand-logo').first().waitFor();
  await until(() => page.locator('.brand-logo').first().evaluate((el) => el.complete && el.naturalWidth === 64));
  await page.getByRole('radio', { name: '#0b8043' }).click();
  await until(async () => (await accent(page)) === '#0b8043');
  await page.screenshot({ path: `${SP}/shots/branding.png` });
});
await step('everyone in the company gets the colour and logo', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await kim.locator('.brand-logo').first().waitFor();
  await until(async () => (await accent(kim)) === '#0b8043');
});
await step('the sign-in page on a company address shows its branding', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const p = await ctx.newPage();
  // As if opened at workspace.acme.com (the test server only answers on localhost).
  await p.route('**/api/public/brand', async (route) => route.fulfill({ json: { brand: { name: 'Acme Trading', accent: '#0b8043', logo: (await api(page, 'GET', '/auth/me')).body.user.org_logo } } }));
  await p.goto(B);
  await p.getByRole('heading', { name: 'Sign in' }).waitFor();
  await p.getByText('Acme Trading').waitFor();
  await p.locator('.brand-logo').waitFor();
  await until(async () => (await accent(p)) === '#0b8043');
  await p.screenshot({ path: `${SP}/shots/branded-signin.png` });
});
await step('back to the usual colour, and no logo', async () => {
  await page.getByRole('radio', { name: '#1a73e8' }).click();
  await until(async () => (await accent(page)) === '#1a73e8');
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.locator('.brand-logo').first().waitFor({ state: 'detached' });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
