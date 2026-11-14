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
const y = new Date().getFullYear();
await step('24 days a year, the first year in proportion; Kim started on 1 October: 6 days this year', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: /Time off/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('tab', { name: 'Team' }).click();
  await dlg.getByLabel('Vacation days a year (company)').fill('24');
  await dlg.getByLabel('Vacation days a year (company)').press('Enter');
  await page.getByText('24 vacation days a year for everyone').waitFor();
  await dlg.getByRole('checkbox', { name: /Give people who start during the year/ }).check();
  await page.getByText('The first year is now in proportion to the start date').waitFor();
  const start = dlg.getByLabel('Start date of Kim Park');
  await start.fill(`${y}-10-01`);
  await start.blur();
  await page.getByText(/Kim Park started on/).waitFor();
  const row = dlg.getByRole('row', { name: /Kim Park/ });
  await row.getByText(/of 6 ·/).waitFor();
  const b = (await api(page, 'GET', `/time-off/team?year=${y}`)).body.people.find((p) => p.id === kim.id);
  if (b.balance.days !== 6 || b.started !== `${y}-10-01`) throw new Error(JSON.stringify(b));
  await page.screenshot({ path: `${SP}/shots/prorate.png` });
  await axe(page, 'team');
});
await step('turned off: the whole year again', async () => {
  const dlg = page.getByRole('dialog', { name: 'Time off' });
  await dlg.getByRole('checkbox', { name: /Give people who start during the year/ }).uncheck();
  await page.getByText('Everyone gets the whole year').waitFor();
  await dlg.getByRole('row', { name: /Kim Park/ }).getByText(/of 24 ·/).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
