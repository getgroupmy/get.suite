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
await step('add “Other” to a multiple-choice and a tick-box question', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Survey' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [
    { id: 'how', type: 'choice', title: 'How did you hear?', options: ['Friend', 'Web'], required: true },
    { id: 'days', type: 'checkbox', title: 'Days', options: ['Mon', 'Tue'] },
  ] });
  await page.goto(`${B}/forms/${form.id}`);
  const q1 = page.getByRole('region', { name: 'Question 1' });
  await q1.getByRole('button', { name: 'add “Other”' }).click();
  await q1.getByText('Other…').waitFor();
  await page.getByRole('region', { name: 'Question 2' }).getByRole('button', { name: 'add “Other”' }).click();
  await until(async () => { const q = await qs(); return q[0].other && q[1].other; }, 10000);
});
await step('filling it in: typing an Other answer chooses it', async () => {
  const ctx = await browser.newContext(); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  await v.goto(`${B}/f/${form.token}`);
  const how = v.getByRole('group', { name: 'How did you hear? (required)' });
  await how.getByLabel('Other', { exact: true }).check();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText('This question needs an answer').waitFor();
  await v.getByLabel('How did you hear?: other answer').fill('A poster');
  await v.getByLabel('Mon').check();
  await v.getByLabel('Days: other answer').fill('Saturday');
  if (!(await v.getByRole('group', { name: 'Days' }).getByLabel('Other', { exact: true }).isChecked())) throw new Error('not ticked');
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  if (r.how !== 'A poster' || r.days.join() !== 'Mon,Saturday') throw new Error(JSON.stringify(r));
});
await step('the summary counts Other and lists what was typed', async () => {
  await page.getByRole('tab', { name: /Responses/ }).click();
  const sum = page.getByRole('region', { name: 'Summary: How did you hear?' });
  await sum.getByText('Other', { exact: true }).waitFor();
  await sum.getByText('What people typed for Other (1)').click();
  await sum.getByText('A poster').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
