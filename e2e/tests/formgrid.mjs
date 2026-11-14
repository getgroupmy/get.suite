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
await step('make grid questions in the editor', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Event feedback' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'name', type: 'short', title: 'Name' }] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 2 title').fill('Rate the day');
  await page.getByLabel('Type of question 2').selectOption('grid');
  await page.getByLabel('Question 2, row 1').fill('Talks');
  await page.getByRole('list', { name: 'Rows of question 2' }).getByRole('button', { name: 'Add row' }).click();
  await page.getByLabel('Question 2, row 2').fill('Food');
  await page.getByLabel('Question 2, column 1').fill('Poor');
  const cols = page.getByRole('list', { name: 'Columns of question 2' });
  await cols.getByRole('button', { name: 'Add column' }).click();
  await page.getByLabel('Question 2, column 2').fill('Good');
  await cols.getByRole('button', { name: 'Add column' }).click();
  await page.getByLabel('Question 2, column 3').fill('Great');
  await page.getByRole('region', { name: 'Question 2' }).getByLabel('Required').check();
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 3 title').fill('Which sessions?');
  await page.getByLabel('Type of question 3').selectOption('checkgrid');
  await page.getByLabel('Question 3, row 1').fill('Morning');
  await page.getByLabel('Question 3, column 1').fill('Went');
  await page.getByRole('list', { name: 'Columns of question 3' }).getByRole('button', { name: 'Add column' }).click();
  await page.getByLabel('Question 3, column 2').fill('Liked');
  await until(async () => {
    const q = await qs();
    return q[1]?.rows?.join() === 'Talks,Food' && q[1].columns.join() === 'Poor,Good,Great' && q[1].required && q[2]?.type === 'checkgrid' && q[2].columns.join() === 'Went,Liked';
  }, 10000);
});
await step('filling it in: every row of a required grid, several per row in a tick-box grid', async () => {
  const ctx = await browser.newContext(); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  form = (await api(page, 'GET', `/forms/${form.id}`)).body;
  await v.goto(`${B}/f/${form.token}`);
  await v.getByLabel('Talks: Good').check();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText('Answer every row').waitFor();
  await v.getByLabel('Food: Great').check();
  await v.getByLabel('Food: Poor').check();
  await v.getByLabel('Morning: Went').check();
  await v.getByLabel('Morning: Liked').check();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  const q = form.questions;
  if (JSON.stringify(r[q[1].id]) !== '{"Talks":"Good","Food":"Poor"}' || JSON.stringify(r[q[2].id]) !== '{"Morning":["Went","Liked"]}') throw new Error(JSON.stringify(r));
});
await step('responses: a count per row and column; each response row by row', async () => {
  await page.getByRole('tab', { name: /Responses/ }).click();
  const sum = page.getByRole('region', { name: 'Summary: Rate the day' });
  await sum.getByLabel('Talks, Good: 1').waitFor();
  await sum.getByLabel('Food, Poor: 1').waitFor();
  await sum.getByLabel('Food, Great: 0').waitFor();
  await page.getByRole('tab', { name: 'Individual' }).click();
  await page.getByText('Morning: Went, Liked').waitFor();
  const csv = await page.evaluate(async (id) => (await fetch(`/api/forms/${id}/responses.csv`, { headers: { 'x-requested-with': 'nas-workspace' } })).text(), form.id);
  if (!csv.includes('Rate the day [Talks],Rate the day [Food],Which sessions? [Morning]') || !csv.includes('Good,Poor,Went; Liked')) throw new Error(csv);
});
await step('Print: every response on its own page, grids row by row', async () => {
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  const frame = page.locator('iframe.print-frame').last();
  await frame.waitFor({ state: 'attached' });
  const html = await frame.getAttribute('srcdoc');
  if (!/<section class="r">/.test(html) || !/Rate the day/.test(html) || !/Talks: Good<br>Food: Poor/.test(html) || !/Morning: Went, Liked/.test(html)) throw new Error(html.slice(0, 600));
});
await step('More → Print a blank copy: the questions with room to answer on paper', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Print a blank copy' }).click();
  await page.waitForFunction(() => { const f = [...document.querySelectorAll('iframe.print-frame')].pop(); return f && /class="grid"/.test(f.getAttribute('srcdoc') || ''); });
  const html = await page.locator('iframe.print-frame').last().getAttribute('srcdoc');
  if (!/2\. Rate the day/.test(html) || !/<th>Talks<\/th>/.test(html) || !/<th>Morning<\/th><td><span class="b">/.test(html)) throw new Error(html.slice(html.indexOf('<body>'), html.indexOf('<body>') + 900));
});
await step('Individual → Print this response: just that one', async () => {
  await page.getByRole('tab', { name: /Responses/ }).click();
  await page.getByRole('tab', { name: 'Individual' }).click();
  await page.getByRole('button', { name: 'Print this response' }).click();
  await page.waitForFunction(() => { const f = [...document.querySelectorAll('iframe.print-frame')].pop(); return f && /Morning: Went, Liked/.test(f.getAttribute('srcdoc') || ''); });
  const html = await page.locator('iframe.print-frame').last().getAttribute('srcdoc');
  if ((html.match(/<section class="r">/g) || []).length !== 1 || /Response 1 of/.test(html)) throw new Error(html.slice(html.indexOf('<body>'), html.indexOf('<body>') + 400));
});
await step('Print summary: the counts as a report', async () => {
  await page.getByRole('button', { name: 'Print summary' }).click();
  await page.waitForFunction(() => { const f = [...document.querySelectorAll('iframe.print-frame')].pop(); return f && /: summary<\/title>/.test(f.getAttribute('srcdoc') || ''); });
  const html = await page.locator('iframe.print-frame').last().getAttribute('srcdoc');
  if (!/<th>Talks<\/th>/.test(html) || !/1 response/.test(html) || !/Rate the day/.test(html)) throw new Error(html.slice(html.indexOf('<body>'), html.indexOf('<body>') + 600));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
