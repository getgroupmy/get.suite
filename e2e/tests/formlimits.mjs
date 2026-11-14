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
await step('the editor sets places per option', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Workshop sign-up' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'slot', type: 'choice', title: 'Session', options: ['Morning', 'Afternoon'], required: true }] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByLabel('Limit places per option').check();
  await page.getByLabel('Places for option 1').fill('1');
  await until(async () => JSON.stringify((await api(page, 'GET', `/forms/${form.id}`)).body.questions[0].limits) === '{"Morning":1}');
  await page.screenshot({ path: `${SP}/shots/formlimits-edit.png` });
});
await step('people see places left; once full, the option can\'t be chosen', async () => {
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  const ctx = await browser.newContext(); const v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(`${B}/f/${form.token}`);
  await v.getByText('1 place left').waitFor();
  await v.getByLabel(/Morning/).check();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const w = await ctx.newPage();
  await w.goto(`${B}/f/${form.token}`);
  await w.getByText('Full').waitFor();
  if (!(await w.getByLabel(/Morning/).isDisabled())) throw new Error('should be disabled');
  await w.getByLabel(/Afternoon/).check();
  await w.screenshot({ path: `${SP}/shots/formlimits-fill.png` });
  await w.getByRole('button', { name: 'Submit' }).click();
  await w.getByText(/Your response has been recorded/).waitFor();
  await ctx.close();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
