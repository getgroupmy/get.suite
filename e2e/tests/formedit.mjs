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
await step('turn on "Let people change their response"', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Lunch order' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [
    { id: 'food', type: 'choice', title: 'Food', options: ['Pizza', 'Salad'], required: true },
    { id: 'note', type: 'short', title: 'Note' },
  ] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/Let people change their response/).check();
  await until(async () => (await api(page, 'GET', `/forms/${form.id}`)).body.allow_edit === true);
});
await step('after sending, the private link brings the answers back to change', async () => {
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  const ctx = await browser.newContext(); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel('Pizza').check();
  await v.getByLabel('Note').fill('No olives');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  await v.getByRole('link', { name: 'Change your response' }).click();
  await v.getByText("You're changing the response you sent.").waitFor();
  if (!(await v.getByLabel('Pizza').isChecked()) || (await v.getByLabel('Note').inputValue()) !== 'No olives') throw new Error('not filled in');
  await v.getByLabel('Salad').check();
  await v.getByRole('button', { name: 'Save changes' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  if (await v.getByRole('button', { name: 'Submit another response' }).count()) throw new Error('offered another while changing');
  const rs = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses;
  if (rs.length !== 1 || rs[0].answers.food !== 'Salad' || rs[0].answers.note !== 'No olives' || !rs[0].updated_at) throw new Error(JSON.stringify(rs));
});
await step('the owner sees it was changed', async () => {
  await page.getByRole('tab', { name: 'Responses' }).click();
  await page.getByRole('button', { name: 'Individual' }).click().catch(() => page.getByRole('tab', { name: 'Individual' }).click());
  await page.getByText(/changed/).first().waitFor();
});
await step('when the form closes, the link says so', async () => {
  await api(page, 'PUT', `/forms/${form.id}`, { accepting: false });
  await v.reload();
  await v.getByText(/no longer accepting responses/).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
