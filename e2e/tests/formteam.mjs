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
let formId, token;
const ed = await mk('eddie');
const anon = await mk('anon');
await step('colleague and a form', async () => {
  const r = await api(page, 'POST', '/users', { local: 'eddie', domain: 'acme.com', name: 'Eddie Editor', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  const f = (await api(page, 'POST', '/forms', { title: 'Offsite ideas', questions: [{ id: 'q1', type: 'short', title: 'Where?' }] })).body;
  formId = f.id; token = f.token;
  await page.goto(`${B}/forms/${formId}?tab=settings`);
});
await step('owner adds an editor', async () => {
  await page.getByLabel('Add an editor').fill('eddie@acme.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('region', { name: 'People who can edit' }).getByText('Eddie Editor').waitFor();
});
await step('editor sees it shared, with a bell', async () => {
  await signIn(ed, 'eddie@acme.com');
  await ed.goto(`${B}/forms`);
  await ed.getByRole('list', { name: 'Your forms' }).getByText('Shared by Olivia Owner').waitFor();
  await ed.getByRole('button', { name: /Notifications, 1 new/ }).click();
  await ed.getByText('Olivia Owner added you to the form “Offsite ideas”').click();
  await ed.waitForURL(/\/forms\//);
  await ed.getByLabel('Question 1 title').waitFor();
});
await step("editor's change reaches the owner live", async () => {
  await page.getByRole('tab', { name: 'Questions' }).click();
  await ed.getByLabel('Question 1 title').fill('Where should we go?');
  await until(async () => (await page.getByLabel('Question 1 title').inputValue()) === 'Where should we go?');
});
await step('editor cannot delete or add people', async () => {
  await ed.getByRole('button', { name: 'More' }).click();
  if (await ed.getByRole('menuitem', { name: 'Delete form' }).count()) throw new Error('delete offered');
  await ed.getByRole('menuitem', { name: 'Leave this form' }).waitFor();
  await ed.keyboard.press('Escape');
  await ed.getByRole('tab', { name: 'Settings' }).click();
  await ed.getByRole('region', { name: 'People who can edit' }).getByText('Owner', { exact: true }).waitFor();
  if (await ed.getByLabel('Add an editor').count()) throw new Error('add offered');
});
await step('response limit closes the form; both see it', async () => {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel(/Anyone with the link/).check();
  await page.getByLabel('Stop after this many responses').fill('1');
  await page.getByLabel('Message after submitting').click(); // blur saves
  await until(async () => (await api(page, 'GET', `/forms/${formId}`)).body.max_responses === 1);
  await anon.goto(`${B}/f/${token}`);
  await anon.getByLabel('Where should we go?').fill('Lake');
  await anon.getByRole('button', { name: 'Submit' }).click();
  await anon.getByText('Your response has been recorded.').waitFor();
  await anon.reload();
  await anon.getByText('This form has all the responses it needs.').waitFor();
  await ed.getByRole('tab', { name: 'Responses (1)' }).click();
  await ed.getByText('reached its limit of 1 responses').waitFor();
  await ed.getByRole('region', { name: 'Summary: Where should we go?' }).getByText('Lake').waitFor();
});
await step('closing time', async () => {
  await page.getByLabel('Stop after this many responses').fill('');
  await page.getByLabel('Message after submitting').click();
  await until(async () => (await api(page, 'GET', `/forms/${formId}`)).body.max_responses === null);
  await page.getByLabel('Close automatically on').fill('2020-01-01T09:00');
  await until(async () => (await api(page, 'GET', `/forms/${formId}`)).body.closed === 'ended');
  await anon.reload();
  await anon.getByText('This form closed.').waitFor();
  await page.getByLabel('Close automatically on').fill('');
  await until(async () => (await api(page, 'GET', `/forms/${formId}`)).body.closed === null);
  await anon.reload();
  await anon.getByRole('button', { name: 'Submit' }).waitFor();
});
await step('owner removes the editor; they are sent back', async () => {
  await page.getByRole('button', { name: 'Remove Eddie Editor' }).click();
  await ed.waitForURL(/\/forms$/);
  await ed.getByText('You were taken off this form').waitFor();
  await ed.getByText('No forms yet').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
