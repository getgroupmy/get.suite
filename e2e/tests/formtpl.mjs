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
await step('The templates you started from last come first in the gallery (after Blank)', async () => {
  await page.goto(`${B}/forms`);
  const g = page.getByRole('region', { name: 'Start a new form' });
  await g.getByRole('button', { name: 'Start from the Quiz template' }).waitFor();
  const order = await g.locator('button.form-tpl strong').allTextContents();
  const all = (await api(page, 'GET', '/forms/templates')).body;
  // (Blank form and From a spreadsheet, then the templates)
  if (order[0] !== 'Blank form' || order[1] !== 'From a spreadsheet' || order[2] !== 'Quiz' || order[3] !== 'Event sign-up') throw new Error(order.join('|'));
  if (order.length !== all.length + 2 || new Set(order).size !== order.length) throw new Error('each once: ' + order.join('|'));
  const rest = all.filter((t) => !['Quiz', 'Event sign-up'].includes(t.title)).map((t) => t.title);
  if (order.slice(4).join('|') !== rest.join('|')) throw new Error('the rest as usual: ' + order.join('|'));
  await page.screenshot({ path: `${SP}/shots/formtpl-lately.png` });
});
await step('Use as my template: one of your forms under Start a new form, starting new ones with its title', async () => {
  await page.goto(`${B}/forms/${formId}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Use as my template' }).click();
  await page.getByText('Added to your templates').waitFor();
  await page.goto(`${B}/forms`);
  const gallery = page.getByRole('region', { name: 'Start a new form' });
  await gallery.getByRole('button', { name: 'Start from your template Event sign-up' }).click();
  await page.waitForURL((u) => /\/forms\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith(formId));
  const id = page.url().split('/forms/')[1];
  const f = (await api(page, 'GET', `/forms/${id}`)).body;
  if (f.title !== 'Event sign-up' || f.my_template || f.questions.length < 2) throw new Error(JSON.stringify({ title: f.title, my: f.my_template, q: f.questions.length }));
  await page.getByRole('button', { name: 'More' }).click();
  if (!(await page.getByRole('menuitem', { name: 'Use as my template' }).count())) throw new Error('the new form offers it too');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: `${SP}/shots/formtpl-mine.png` });
});
await step('Start a new form → From a spreadsheet: a spreadsheet in Drive picked, its headings the questions', async () => {
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Workshop interest', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Which workshop?', B1: 'Anything else?', A2: 'Pottery', A3: 'Painting', A4: 'Pottery' } }] } });
  await page.goto(`${B}/forms`);
  await page.getByRole('region', { name: 'Start a new form' }).getByRole('button', { name: /From a spreadsheet/ }).click();
  const pick = page.getByRole('dialog', { name: 'Make a form from a spreadsheet' });
  await pick.getByLabel('Search your files').fill('Workshop interest');
  await pick.getByRole('button', { name: /Workshop interest/ }).click();
  await page.waitForURL(/\/forms\/[\w-]+/);
  await page.getByText('Made the form “Workshop interest”').waitFor();
  const id = page.url().split('/forms/')[1].split(/[?#/]/)[0];
  const f = (await api(page, 'GET', `/forms/${id}`)).body;
  if (f.questions.map((x) => `${x.type}:${x.title}:${(x.options || []).join('/')}`).join('|') !== 'choice:Which workshop?:Pottery/Painting|short:Anything else?:' || !f.linked_sheet) throw new Error(JSON.stringify(f));
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
