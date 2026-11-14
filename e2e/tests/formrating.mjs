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
let form, v;
const qs = async () => (await api(page, 'GET', `/forms/${form.id}`)).body.questions;
await step('make a time and a rating question in the editor', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Visit' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'name', type: 'short', title: 'Name' }] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 2 title').fill('Arrival time');
  await page.getByLabel('Type of question 2').selectOption('time');
  await page.getByText('They pick a time').waitFor();
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 3 title').fill('How was it?');
  await page.getByLabel('Type of question 3').selectOption('rating');
  await page.getByLabel('Levels of question 3').selectOption('4');
  await page.getByLabel('Rating icon of question 3').selectOption('heart');
  await until(async () => { const q = await qs(); return q[1]?.type === 'time' && q[2]?.type === 'rating' && q[2].max === 4 && q[2].icon === 'heart'; }, 10000);
});
await step('filling it in: pick a time and a number of hearts', async () => {
  const ctx = await browser.newContext(); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel('Arrival time').fill('14:30');
  const rating = v.getByRole('radiogroup', { name: /How was it/ });
  if ((await rating.locator('label').count()) !== 4) throw new Error('levels');
  if (!(await rating.locator('label').first().innerText()).includes('♥')) throw new Error('icon');
  await v.getByLabel('3 of 4').check({ force: true });
  await v.getByRole('radiogroup', { name: 'How was it?: 3 of 4' }).waitFor();
  if ((await rating.locator('label.on').count()) !== 3) throw new Error('fill');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  const q = form.questions;
  if (r[q[1].id] !== '14:30' || r[q[2].id] !== 3) throw new Error(JSON.stringify(r));
});
await step('the summary shows the average rating', async () => {
  await page.getByRole('tab', { name: /Responses/ }).click();
  await page.getByRole('region', { name: 'Summary: How was it?' }).getByText('average 3').waitFor();
  await page.getByRole('region', { name: 'Summary: Arrival time' }).getByText('14:30').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
