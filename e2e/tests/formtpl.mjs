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
  await page.goto(`${B}/forms`);
});
let formId;
await step('The gallery: start from Event sign-up', async () => {
  const gallery = page.getByRole('region', { name: 'Start a new form' });
  await gallery.getByRole('button', { name: 'Blank form' }).waitFor();
  if ((await gallery.getByRole('button', { name: /^Start from the .* template$/ }).count()) !== 8) throw new Error('eight templates');
  await page.screenshot({ path: `${SP}/shots/formtpl.png` });
  await gallery.getByRole('button', { name: 'Start from the Event sign-up template' }).click();
  await page.waitForURL(/\/forms\/[^/]+$/);
  formId = page.url().split('/forms/')[1];
  await page.getByLabel('Question 2, option 1', { exact: true }).waitFor();
  if ((await page.getByLabel('Question 2, option 1', { exact: true }).inputValue()) !== 'Morning (9:00–12:00)') throw new Error('options');
  const f = (await api(page, 'GET', `/forms/${formId}`)).body;
  if (f.title !== 'Event sign-up' || !f.one_per_person || f.questions[1].limits['Morning (9:00–12:00)'] !== 30) throw new Error(JSON.stringify(f));
});
await step('Filled in: places left show, and the message after sending', async () => {
  const f = (await api(page, 'GET', `/forms/${formId}`)).body;
  await page.goto(`${B}/f/${f.token}`);
  await page.getByText(/30 (places )?left/).first().waitFor();
  await page.getByLabel('Your name (required)').fill('Olivia');
  await page.getByLabel('Afternoon (13:00–16:00)').check();
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText('Thanks, you are signed up. See you there!').waitFor();
});
await step('A quiz from its template is scored', async () => {
  await page.goto(`${B}/forms`);
  await page.getByRole('button', { name: 'Start from the Quiz template' }).click();
  await page.waitForURL(/\/forms\/[^/]+$/);
  const id = page.url().split('/forms/')[1];
  const f = (await api(page, 'GET', `/forms/${id}`)).body;
  if (!f.quiz || f.questions[1].answer !== '56') throw new Error(JSON.stringify(f).slice(0, 300));
  await page.goto(`${B}/forms`);
  await page.getByRole('list', { name: 'Your forms' }).getByText('Quiz').waitFor();
  await page.getByRole('list', { name: 'Your forms' }).getByText('Event sign-up').waitFor();
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
