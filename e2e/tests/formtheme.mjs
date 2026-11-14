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
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let form;
await step('a new form starts plain; 🎨 Theme picks a colour, a tinted page and a font, saved straight away', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Summer party' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'q1', type: 'choice', title: 'Coming?', options: ['Yes', 'No'], required: true }] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('button', { name: '🎨 Theme' }).click();
  const dlg = page.getByRole('dialog', { name: 'Theme' });
  if ((await dlg.getByRole('radio', { name: 'Default' }).getAttribute('aria-checked')) !== 'true') throw new Error('starts plain');
  await dlg.getByRole('radio', { name: 'Teal' }).click();
  await until(async () => (await dlg.getByRole('radio', { name: 'Teal' }).getAttribute('aria-checked')) === 'true');
  await dlg.getByLabel('Tinted with the colour').check();
  await dlg.getByLabel('Font').selectOption('playful');
  await until(async () => JSON.stringify((await api(page, 'GET', `/forms/${form.id}`)).body.theme) === JSON.stringify({ color: 'teal', font: 'playful', background: 'tinted' }));
  const accent = await dlg.locator('.form-theme-preview').evaluate((e) => getComputedStyle(e).borderTopColor);
  if (accent !== 'rgb(0, 121, 107)') throw new Error(`preview accent ${accent}`);
});
await step('a header picture is added from the computer, and shown in the window', async () => {
  const dlg = page.getByRole('dialog', { name: 'Theme' });
  await dlg.getByLabel('Header picture').setInputFiles({ name: 'balloons.png', mimeType: 'image/png', buffer: png });
  const img = dlg.getByRole('img', { name: 'balloons' });
  await img.waitFor();
  await until(() => img.evaluate((e) => e.complete && e.naturalWidth > 0));
  await page.screenshot({ path: `${SP}/shots/formtheme-dialog.png` });
  await dlg.getByRole('button', { name: 'Done' }).click();
  await dlg.waitFor({ state: 'detached' });
});
await step('people filling it in see the colour, tint, font and header picture (signed out too)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anon = await ctx.newPage();
  anon.on('pageerror', (e) => errors.push(`anon: ${e.message}`));
  await anon.goto(`${B}/f/${form.token}`);
  const header = anon.getByRole('img', { name: 'balloons' });
  await header.waitFor();
  await until(() => header.evaluate((e) => e.complete && e.naturalWidth > 0));
  const card = anon.locator('form.invite-card');
  const s = await card.evaluate((e) => ({ top: getComputedStyle(e).borderTopColor, font: getComputedStyle(e).fontFamily, page: getComputedStyle(e.closest('.link-page')).backgroundColor }));
  if (s.top !== 'rgb(0, 121, 107)') throw new Error(`accent ${s.top}`);
  if (!/Trebuchet/.test(s.font)) throw new Error(`font ${s.font}`);
  if (/rgb\(255, 255, 255\)|rgb\(248, 249, 250\)/.test(s.page)) throw new Error(`page not tinted: ${s.page}`);
  const submit = anon.getByRole('button', { name: 'Submit' });
  const bg = await submit.evaluate((e) => getComputedStyle(e).backgroundColor);
  if (bg !== 'rgb(0, 121, 107)') throw new Error(`button ${bg}`);
  await anon.screenshot({ path: `${SP}/shots/formtheme-fill.png`, fullPage: true });
  await anon.getByLabel('Yes').check();
  await submit.click();
  await anon.getByText('Your response has been recorded.').waitFor();
  await ctx.close();
});
await step('Reset to plain takes it all off', async () => {
  await page.getByRole('button', { name: '🎨 Theme' }).click();
  const dlg = page.getByRole('dialog', { name: 'Theme' });
  await dlg.getByRole('button', { name: 'Reset to plain' }).click();
  await until(async () => (await api(page, 'GET', `/forms/${form.id}`)).body.theme === null);
  await dlg.getByRole('button', { name: 'Add a header picture' }).waitFor();
  await page.goto(`${B}/f/${form.token}`);
  await page.getByRole('heading', { name: 'Summer party' }).waitFor();
  if (await page.locator('.form-theme-header').count()) throw new Error('header still shown');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
