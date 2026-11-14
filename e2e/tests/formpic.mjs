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
let form;
const loaded = (p, sel) => p.locator(sel).first().evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
await step('add a picture to a question in the editor, with a description', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Logo vote' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'pick', type: 'choice', title: 'Which logo?', options: ['Left', 'Right'] }] });
  await page.goto(`${B}/forms/${form.id}`);
  const card = page.getByRole('region', { name: 'Question 1' });
  await card.getByLabel('Picture for question 1', { exact: true }).setInputFiles(`${ROOT}/e2e/fixtures/blue.png`);
  await until(() => loaded(page, '[aria-label="Question 1"] img.form-q-picture'));
  await card.getByLabel('Picture description for question 1').fill('Two logo designs side by side');
  await until(async () => (await api(page, 'GET', `/forms/${form.id}`)).body.questions[0].image_alt === 'Two logo designs side by side');
  await page.screenshot({ path: `${SP}/shots/formpic-edit.png` });
});
await step('anyone with the link sees it above the question', async () => {
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  const ctx = await browser.newContext(); const v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(`${B}/f/${form.token}`);
  const img = v.getByRole('img', { name: 'Two logo designs side by side' });
  await img.waitFor();
  await until(() => loaded(v, 'img.form-q-picture'));
  await v.screenshot({ path: `${SP}/shots/formpic-fill.png` });
  await v.getByLabel('Right').check();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  await ctx.close();
});
await step('Remove picture takes it off', async () => {
  await page.getByRole('region', { name: 'Question 1' }).getByRole('button', { name: 'Remove picture' }).click();
  await until(async () => !(await api(page, 'GET', `/forms/${form.id}`)).body.questions[0].image);
});
await step('pictures on options: each choice shows its own, and follows a renamed option', async () => {
  const card = page.getByRole('region', { name: 'Question 1' });
  await card.getByLabel('Picture for question 1, option 1').setInputFiles(`${ROOT}/e2e/fixtures/blue.png`);
  await card.getByLabel('Picture for question 1, option 2').setInputFiles(`${ROOT}/e2e/fixtures/blue.png`);
  await until(async () => Object.keys((await api(page, 'GET', `/forms/${form.id}`)).body.questions[0].option_images || {}).length === 2);
  await card.getByLabel('Question 1, option 2', { exact: true }).fill('Right one');
  await until(async () => (await api(page, 'GET', `/forms/${form.id}`)).body.questions[0].option_images?.['Right one']);
  const ctx = await browser.newContext(); const v = await ctx.newPage();
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel(/Right one/).waitFor();
  await until(async () => (await v.locator('.form-option-pic img').evaluateAll((l) => l.filter((i) => i.complete && i.naturalWidth > 0).length)) === 2);
  await v.screenshot({ path: `${SP}/shots/formpic-options.png` });
  await ctx.close();
  await card.getByRole('button', { name: 'Remove picture from question 1, option 1' }).click();
  await until(async () => { const im = (await api(page, 'GET', `/forms/${form.id}`)).body.questions[0].option_images; return im && !im.Left && im['Right one']; });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
