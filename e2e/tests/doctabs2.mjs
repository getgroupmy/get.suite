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
let id;
const ed = () => page.locator('.doc-scroll .ProseMirror');
const panel = () => page.getByRole('navigation', { name: 'Document tabs' });
const outline = () => page.getByRole('navigation', { name: 'Outline' });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
await step('the outline shows the open tab\'s headings', async () => {
  const content = { type: 'doc', content: [
    { type: 'docTab', attrs: { id: 'plan', title: 'Plan' }, content: [h(1, 'Goals'), p('Open two shops this spring.')] },
    { type: 'docTab', attrs: { id: 'money', title: 'Budget' }, content: [h(1, 'Costs'), p('Rent and staff come to four thousand.'), h(2, 'Savings')] },
  ] };
  id = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Spring', content })).body.id;
  await page.goto(`${B}/docs/${id}`);
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  if (!(await outline().count())) await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await outline().getByRole('button', { name: 'Goals', exact: true }).waitFor();
  if (await outline().getByRole('button', { name: 'Costs', exact: true }).count()) throw new Error('another tab\'s heading');
  await panel().getByRole('button', { name: 'Budget', exact: true }).click();
  await outline().getByRole('button', { name: 'Savings', exact: true }).waitFor();
  if (await outline().getByRole('button', { name: 'Goals', exact: true }).count()) throw new Error('the first tab\'s heading');
});
await step('a link to a tab opens the document there', async () => {
  await page.goto(`${B}/docs/${id}#tab=money`);
  await ed().getByText('Rent and staff come to four thousand.').waitFor({ state: 'visible' });
  if (await ed().getByText('Open two shops this spring.').isVisible()) throw new Error('first tab shown');
});
await step('a comment in a tab is kept there, and opening it from the list opens its tab', async () => {
  await ed().getByText('Rent and staff come to four thousand.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft'); // before the full stop
  for (let i = 0; i < 13; i++) await page.keyboard.press('Shift+ArrowLeft'); // "four thousand"
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByText('On “four thousand”').waitFor();
  await page.getByLabel('New comment').fill('Is this with the new hires?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.locator('.comment-thread', { hasText: 'Is this with the new hires?' }).waitFor();
  await panel().getByRole('button', { name: 'Plan', exact: true }).click();
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  await page.locator('.comment-thread').getByText('Is this with the new hires?').click();
  await ed().locator('[data-comment]', { hasText: 'four thousand' }).waitFor({ state: 'visible' });
});
await step('suggesting works in a tab; word count covers every tab', async () => {
  await page.getByLabel('Editing mode').selectOption('suggest');
  await ed().getByText('Rent and staff come to four thousand.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Maybe less.');
  await ed().locator('ins', { hasText: 'Maybe less.' }).waitFor();
  await page.getByLabel('Editing mode').selectOption('edit');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Word count' }).click();
  const dlg = page.getByRole('dialog', { name: 'Word count' });
  const words = () => dlg.locator('tr:has(th:text-is("Words"))').locator('td').last().innerText();
  // Goals(1) Open two shops this spring(5) Costs(1) Rent and staff come to four thousand(7) Savings(1) [+ the suggestion, 2]
  await until(async () => Number(await words()) >= 15);
  await page.screenshot({ path: `${SP}/shots/doctabs-comment.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
