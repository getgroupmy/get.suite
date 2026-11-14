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
let src, target;
await step('two forms: an old survey with a section jump, and a new one', async () => {
  src = (await api(page, 'POST', '/forms', { title: 'Old survey' })).body;
  await api(page, 'PUT', `/forms/${src.id}`, { questions: [
    { id: 'name', type: 'short', title: 'Your name', required: true },
    { id: 'diet', type: 'choice', title: 'Diet', options: ['Veg', 'Any'], goto: { Veg: 'sec2' } },
    { id: 'sec2', type: 'section', title: 'Veg details' },
    { id: 'kind', type: 'dropdown', title: 'Which kind?', options: ['Vegan', 'Vegetarian'] },
  ] });
  target = (await api(page, 'POST', '/forms', { title: 'Team lunch', questions: [{ id: 'q1', type: 'short', title: 'When suits you?' }] })).body;
});
await step('⋮ → Import questions: pick the form, untick one, import the rest to the end', async () => {
  await page.goto(`${B}/forms/${target.id}`);
  await page.getByRole('textbox', { name: 'Form title' }).waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Import questions…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Import questions' });
  await dlg.getByLabel('From the form').selectOption({ label: 'Old survey' });
  const list = dlg.getByRole('list', { name: 'Questions to import' });
  await list.getByText('Veg details').waitFor();
  if ((await list.getByRole('checkbox').count()) !== 4) throw new Error('four to pick from');
  await list.getByRole('listitem').filter({ hasText: 'Your name' }).getByRole('checkbox').uncheck();
  await dlg.getByRole('button', { name: 'Import 3' }).click();
  await page.getByText('3 questions added at the end').waitFor();
  await dlg.waitFor({ state: 'detached' });
  await page.screenshot({ path: `${SP}/shots/forms-import.png`, fullPage: true });
});
await step('they\'re on the form, the jump goes to the copied section, and they stay after a reload', async () => {
  await page.reload();
  await page.getByRole('region', { name: 'Section: Veg details' }).waitFor();
  const f = (await api(page, 'GET', `/forms/${target.id}`)).body;
  const titles = f.questions.map((x) => x.title);
  if (titles.join('|') !== 'When suits you?|Diet|Veg details|Which kind?') throw new Error(titles.join('|'));
  if (f.questions[1].goto?.Veg !== f.questions[2].id) throw new Error('jump not remapped');
  if ((await api(page, 'GET', `/forms/${src.id}`)).body.questions.length !== 4) throw new Error('source changed');
  // Filling it in: choosing Veg goes to the copied section.
  await page.goto(`${B}/f/${f.token}`);
  await page.getByLabel('When suits you?').fill('Friday');
  await page.getByLabel('Veg').check();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('heading', { name: 'Veg details' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
