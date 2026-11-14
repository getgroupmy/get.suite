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
const next = new Date().getFullYear() + 1;
await step('Add public holidays…: a country\'s holidays for a year, those already there kept', async () => {
  await api(page, 'POST', '/time-off/holidays', { date: `${next}-01-01`, name: 'Our New Year' });
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('tab', { name: 'Team' }).click();
  const hol = dlg.getByRole('region', { name: 'Company holidays' });
  await hol.getByRole('button', { name: 'Add public holidays…' }).click();
  const m = page.getByRole('dialog', { name: 'Add public holidays' });
  await m.getByLabel('Country').selectOption('GB');
  await m.getByLabel('Year').selectOption(String(next));
  const list = m.getByRole('list', { name: `Public holidays in ${next}` });
  await list.getByText(/Easter Monday/).waitFor();
  await list.getByText(/New Year's Day \(already a company holiday\)/).waitFor();
  const n = await list.getByRole('listitem').count();
  await m.getByRole('button', { name: `Add ${n - 1} holidays` }).waitFor();
  await page.screenshot({ path: `${SP}/shots/public-holidays.png` });
  await axe(page, 'public holidays');
  await m.getByRole('button', { name: `Add ${n - 1} holidays` }).click();
  await page.getByText(`Added ${n - 1} holidays (1 already there)`).waitFor();
  await hol.getByText(/Summer bank holiday/).waitFor();
  await hol.getByText(/Our New Year/).waitFor();
  const all = (await api(page, 'GET', `/time-off/holidays?from=${next}-01-01&to=${next}-12-31`)).body;
  if (all.length !== n) throw new Error(`${all.length} vs ${n}`);
  // Opening it again: nothing left to add.
  await hol.getByRole('button', { name: 'Add public holidays…' }).click();
  await m.getByLabel('Year').selectOption(String(next));
  await m.getByRole('button', { name: 'Nothing to add' }).waitFor();
  if (!(await m.getByLabel('Country').inputValue() === 'GB')) throw new Error('country remembered');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
