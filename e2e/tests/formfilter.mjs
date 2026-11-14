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
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};
let form;
await step('a form with four responses', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Offsite' })).body;
  form = (await api(page, 'PUT', `/forms/${form.id}`, { audience: 'org', questions: [
    { id: 'where', type: 'choice', title: 'Where?', options: ['Lisbon', 'Porto'] },
    { id: 'stars', type: 'rating', title: 'Excited?', max: 5 },
    { id: 'wish', type: 'paragraph', title: 'Wish' },
  ] })).body;
  for (const [where, stars, wish] of [['Lisbon', 5, 'Sailing trip'], ['Porto', 3, 'Port wine tasting'], ['Lisbon', 4, 'Tram ride'], ['Porto', 5, '']]) {
    const r = await page.evaluate(async ([t, a]) => (await fetch(`/api/public/forms/${t}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ answers: a }) })).status, [form.token, { where, stars, ...(wish && { wish }) }]);
    if (r !== 201) throw new Error(String(r));
  }
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: /Responses/ }).click();
  await page.getByText('4 responses').waitFor();
});
await step('filter by a choice: the count, the summary, each response and the downloads follow it', async () => {
  const bar = page.getByRole('group', { name: 'Filter responses' });
  await bar.getByLabel('Filter by question').selectOption({ label: 'Where?' });
  await bar.getByLabel('Answer to filter by').selectOption('Lisbon');
  await page.getByText('2 of 4 responses').waitFor();
  await page.getByRole('region', { name: 'Summary: Excited?' }).getByText('average 4.5').waitFor();
  await page.getByRole('region', { name: 'Summary: Wish' }).getByText('Tram ride').waitFor();
  if (await page.getByText('Port wine tasting').count()) throw new Error('Porto shown');
  await page.screenshot({ path: `${SP}/shots/form-filter.png` });
  await axe(page, 'filter');
  const href = await page.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
  if (!/\?fq=where&fv=Lisbon$/.test(href)) throw new Error(href);
  const csv = await page.evaluate(async (h) => (await fetch(h)).text(), href);
  if ((csv.match(/Lisbon/g) || []).length !== 2 || /Porto/.test(csv)) throw new Error(csv);
  await page.getByRole('tab', { name: 'Individual' }).click();
  await page.getByText(/^1 of 2 ·/).waitFor();
});
await step('by a rating, by words written, by left blank; nothing matching; clear', async () => {
  const bar = page.getByRole('group', { name: 'Filter responses' });
  await page.getByRole('tab', { name: 'Summary' }).click();
  await bar.getByLabel('Filter by question').selectOption({ label: 'Excited?' });
  await bar.getByLabel('Answer to filter by').selectOption('5');
  await page.getByText('2 of 4 responses').waitFor();
  await bar.getByLabel('Filter by question').selectOption({ label: 'Wish' });
  await bar.getByLabel('Words in the answer').fill('WINE');
  await page.getByText('1 of 4 responses').waitFor();
  await page.getByRole('region', { name: 'Summary: Wish' }).getByText('Port wine tasting').waitFor();
  await bar.getByLabel('Answer to filter by').selectOption({ label: 'Left blank' });
  await page.getByText('1 of 4 responses').waitFor();
  await bar.getByLabel('Answer to filter by').selectOption({ label: 'Contains…' });
  await bar.getByLabel('Words in the answer').fill('zeppelin');
  await page.getByText('No responses match').waitFor();
  await page.getByRole('button', { name: 'show all responses' }).click();
  await page.getByText('4 responses').waitFor();
  if (await bar.getByLabel('Answer to filter by').count()) throw new Error('filter stayed');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
