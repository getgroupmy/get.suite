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
let form, v;
await step('setup: a public form with a ranking question', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  form = (await api(page, 'POST', '/forms', { title: 'Offsite' })).body;
  form = (await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [
    { id: 'where', type: 'rank', title: 'Rank the venues', options: ['Lisbon', 'Porto', 'Faro'], required: true },
  ] })).body;
});
await step('Filling it in: untouched is not answered; ↑ ↓ put them in order', async () => {
  const ctx = await browser.newContext(); v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await v.goto(`${B}/f/${form.token}`);
  const list = v.getByRole('list', { name: 'Rank the venues: your order' });
  await list.getByText('Faro').waitFor();
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText('This question needs an answer').waitFor();
  await v.getByRole('button', { name: 'Move Faro up' }).click();
  await v.getByRole('button', { name: 'Move Faro up' }).click();
  const order = await list.locator('li').evaluateAll((l) => l.map((x) => x.querySelector('.grow').textContent));
  if (order.join() !== 'Faro,Lisbon,Porto') throw new Error(order.join());
  if (!(await v.getByRole('button', { name: 'Move Faro up' }).isDisabled())) throw new Error('the first can\'t go up');
  await v.screenshot({ path: `${SP}/shots/formrank.png` });
  await v.getByRole('button', { name: 'Submit' }).click();
  await v.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses[0].answers;
  if (r.where.join() !== 'Faro,Lisbon,Porto') throw new Error(JSON.stringify(r));
});
await step('"Keep this order" answers as it stands', async () => {
  const ctx = await browser.newContext(); const w = await ctx.newPage();
  await w.goto(`${B}/f/${form.token}`);
  await w.getByRole('button', { name: 'Keep this order' }).click();
  await w.getByRole('button', { name: 'Keep this order' }).waitFor({ state: 'detached' });
  await w.getByRole('button', { name: 'Submit' }).click();
  await w.getByText(/Your response has been recorded/).waitFor();
  await ctx.close();
});
await step('Results: average place, and each response in order', async () => {
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Responses' }).click();
  const sum = page.getByRole('list', { name: 'Average places' });
  await sum.waitFor();
  const lines = await sum.locator('li').allInnerTexts();
  // Faro: 1 and 3 → 2; Lisbon: 2 and 1 → 1.5; Porto: 3 and 2 → 2.5
  const flat = lines.map((l) => l.replace(/\s+/g, ' ').trim());
  if (!/^Lisbon ?average place 1\.5 · first for 1$/.test(flat[0]) || !/^Faro ?average place 2 · first for 1$/.test(flat[1]) || !/^Porto ?average place 2\.5$/.test(flat[2])) throw new Error(JSON.stringify(flat));
  await page.getByRole('button', { name: 'Individual' }).click().catch(() => page.getByRole('tab', { name: 'Individual' }).click());
  await page.getByText('1. Faro').waitFor();
});
await step('In the editor: Ranking keeps 2 to 10 options and has no places', async () => {
  await page.getByRole('tab', { name: 'Questions' }).click();
  await page.getByLabel('Type of question 1').selectOption({ label: 'Multiple choice' });
  await page.getByText('Limit places per option').waitFor();
  await page.getByLabel('Type of question 1').selectOption({ label: 'Ranking' });
  await page.getByLabel('Question 1, option 3').waitFor();
  if (await page.getByText('Limit places per option').count()) throw new Error('places offered');
  for (let n = 4; n <= 10; n++) await page.getByRole('button', { name: 'Add option' }).click();
  await page.getByLabel('Question 1, option 10').waitFor();
  if (await page.getByRole('button', { name: 'Add option' }).count()) throw new Error('more than 10');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
