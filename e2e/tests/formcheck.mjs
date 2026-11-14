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
await step('add rules in the editor: a number range, an email, at most two tick boxes', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Club sign-up' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [
    { id: 'age', type: 'short', title: 'Age', required: true },
    { id: 'mail', type: 'short', title: 'Email' },
    { id: 'days', type: 'checkbox', title: 'Days', options: ['Mon', 'Tue', 'Wed'] },
    { id: 'when', type: 'date', title: 'Start date' },
  ] });
  await page.goto(`${B}/forms/${form.id}`);
  if (await page.getByRole('group', { name: 'Response validation for question 4' }).count()) throw new Error('offered for dates');
  const g1 = page.getByRole('group', { name: 'Response validation for question 1' });
  await g1.getByLabel('Response validation').check();
  await page.getByLabel('Rule for question 1', { exact: true }).selectOption('between');
  await page.getByLabel('Value for question 1', { exact: true }).fill('18');
  await g1.getByText(/Enter both numbers for the rule/).waitFor();
  await page.getByLabel('Second value for question 1').fill('99');
  await page.getByLabel('Error message for question 1').fill('Members must be adults');
  if (await g1.getByRole('alert').count()) throw new Error('still a problem');
  await page.getByRole('group', { name: 'Response validation for question 2' }).getByLabel('Response validation').check();
  await page.getByLabel('Kind of rule for question 2').selectOption('text');
  await page.getByLabel('Rule for question 2', { exact: true }).selectOption('email');
  await page.getByRole('group', { name: 'Response validation for question 3' }).getByLabel('Response validation').check();
  await page.getByLabel('Rule for question 3', { exact: true }).selectOption('atmost');
  await page.getByLabel('Value for question 3', { exact: true }).fill('2');
  await until(async () => {
    const q = await qs();
    return q[0].check?.b === 99 && q[0].check.msg === 'Members must be adults' && q[1].check?.op === 'email' && q[2].check?.a === 2;
  }, 10000);
});
await step('filling it in: answers that don\'t fit are explained and stop the form', async () => {
  const ctx = await browser.newContext(); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel('Age (required)').fill('12');
  await v.getByLabel('Email').click(); // leaving the box checks it
  await v.getByText('Members must be adults').waitFor();
  await v.getByLabel('Email').fill('not-an-address');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText('Enter an email address').waitFor();
  for (const d of ['Mon', 'Tue', 'Wed']) await v.getByLabel(d).check();
  await v.getByText('Choose at most 2').waitFor();
  if ((await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses.length) throw new Error('sent');
  await v.getByLabel('Wed').uncheck();
  await v.getByLabel('Age (required)').fill('30');
  await v.getByLabel('Email').fill('kim@example.com');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  if (r.age !== '30' || r.mail !== 'kim@example.com' || r.days.join() !== 'Mon,Tue') throw new Error(JSON.stringify(r));
});
await step('turning a rule off', async () => {
  await page.getByRole('group', { name: 'Response validation for question 2' }).getByLabel('Response validation').uncheck();
  await until(async () => !(await qs())[1].check, 10000);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
