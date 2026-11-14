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
await step('shuffle option order is a setting on choice questions', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Team lunch' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [
    { id: 'name', type: 'short', title: 'Name' },
    { id: 'team', type: 'choice', title: 'Team', options: ['Sales', 'Ops', 'Finance', 'Support', 'Legal', 'IT'] },
    { id: 'days', type: 'checkbox', title: 'Days', options: ['Mon', 'Tue', 'Wed'] },
  ] });
  await page.goto(`${B}/forms/${form.id}`);
  if (await page.getByRole('region', { name: 'Question 1' }).getByLabel('Shuffle option order').count()) throw new Error('offered for short answer');
  await page.getByRole('region', { name: 'Question 2' }).getByLabel('Shuffle option order').check();
  await until(async () => (await qs())[1].shuffle === true, 10000);
});
await step('get a pre-filled link from the editor', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Get pre-filled link' }).click();
  const dlg = page.getByRole('dialog', { name: 'Get pre-filled link' });
  if (!(await dlg.getByRole('button', { name: 'Copy link' }).isDisabled())) throw new Error('copy before any answer');
  await dlg.getByLabel('Name').fill('Kim');
  await dlg.getByLabel('Ops').check();
  await dlg.getByLabel('Tue').check();
  v = await dlg.getByLabel('Pre-filled link').inputValue();
  if (!v.includes(`/f/${form.token}?prefill=`)) throw new Error(v);
  await dlg.getByRole('button', { name: 'Copy link' }).click();
  await page.getByText('Pre-filled link copied').or(page.getByText(v)).first().waitFor();
  await dlg.getByRole('button', { name: 'Close', exact: true }).last().click();
});
await step('the link opens the form filled in; people can change it and send', async () => {
  const ctx = await browser.newContext(); const visitor = await ctx.newPage();
  visitor.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await visitor.goto(v);
  await until(async () => (await visitor.getByLabel('Name').inputValue()) === 'Kim');
  if (!(await visitor.getByLabel('Ops').isChecked()) || !(await visitor.getByLabel('Tue').isChecked())) throw new Error('not filled');
  const labels = await visitor.getByRole('group', { name: 'Team' }).locator('label').allInnerTexts();
  if ([...labels].sort().join() !== 'Finance,IT,Legal,Ops,Sales,Support') throw new Error(labels.join());
  await visitor.getByLabel('Wed').check();
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await visitor.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  if (r.name !== 'Kim' || r.team !== 'Ops' || r.days.join() !== 'Tue,Wed') throw new Error(JSON.stringify(r));
  // A link with answers that don't fit is just ignored.
  await visitor.goto(`${B}/f/${form.token}?prefill=${encodeURIComponent('{"team":"Marketing","name":{"x":1}}')}`);
  await visitor.getByLabel('Name').waitFor();
  if ((await visitor.getByLabel('Name').inputValue()) !== '') throw new Error('bad prefill used');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
