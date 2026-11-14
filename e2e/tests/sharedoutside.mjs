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

let gil, ids = {};
await step('Admin → Shared outside lists what people share with other companies, by company', async () => {
  for (const [name, domain, local] of [['Globex', 'globex.com', 'gil'], ['Initech', 'initech.com', 'ivy']]) {
    const r = await api(page, 'POST', '/orgs', { name, domain, admin_name: local === 'gil' ? 'Gil Green' : 'Ivy Ito', admin_local: local, admin_password: 'password123' });
    if (r.status !== 201) throw new Error(JSON.stringify(r));
  }
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  for (const e of ['gil@globex.com', 'ivy@initech.com']) ids[e] = (await api(kim, 'GET', `/users/lookup?email=${e}`)).body.id;
  const up = (n, t) => kim.evaluate(async ([a, b]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(a)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: b })).json(), [n, t]);
  const plan = await up('Launch plan.txt', 'the plan');
  const price = await up('Price list.txt', 'prices');
  await api(kim, 'PUT', `/files/${plan.id}/shares`, { shares: [{ user_id: ids['gil@globex.com'], role: 'editor' }, { user_id: ids['ivy@initech.com'], role: 'viewer' }] });
  await api(kim, 'PUT', `/files/${price.id}/shares`, { shares: [{ user_id: ids['gil@globex.com'], role: 'viewer' }] });
  ids.plan = plan.id; ids.price = price.id;
  gil = await mk('gil');
  await signIn(gil, 'gil@globex.com');
  if ((await api(gil, 'GET', `/files/${plan.id}`)).status !== 200) throw new Error('gil should see it');
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Shared outside' }).click();
  const table = page.getByRole('table', { name: 'Shared outside the company' });
  await table.locator('tbody tr').first().waitFor();
  if ((await table.locator('tbody tr').count()) !== 3) throw new Error(await table.innerText());
  await table.locator('tr', { hasText: 'Price list.txt' }).getByText('Can view').waitFor();
  const companies = page.getByRole('list', { name: 'Companies' });
  await companies.getByRole('button', { name: 'Globex · 2 shares, 1 person' }).waitFor();
  await companies.getByRole('button', { name: 'Initech · 1 share, 1 person' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/shared-outside.png` });
  await axe(page, 'shared outside');
});

await step('stop one share: Gil can’t open it any more, Kim is told', async () => {
  const table = page.getByRole('table', { name: 'Shared outside the company' });
  await table.getByRole('button', { name: 'Stop sharing Price list.txt with gil@globex.com' }).click();
  await page.getByRole('dialog', { name: 'Stop this share?' }).getByRole('button', { name: 'Stop sharing' }).click();
  await page.getByText('Sharing stopped').waitFor();
  await until(async () => (await table.locator('tbody tr').count()) === 2);
  if ((await api(gil, 'GET', `/files/${ids.price}`)).status !== 404) throw new Error('gil still has it');
});

await step('narrow to one company and stop everything shared with it', async () => {
  await page.getByRole('list', { name: 'Companies' }).getByRole('button', { name: /^Globex/ }).click();
  const table = page.getByRole('table', { name: 'Shared outside the company' });
  await until(async () => (await table.locator('tbody tr').count()) === 1);
  await page.getByRole('button', { name: 'Stop sharing everything with Globex…' }).click();
  await page.getByRole('dialog', { name: 'Stop sharing everything with Globex?' }).getByRole('button', { name: 'Stop all' }).click();
  await page.getByText('1 share stopped').waitFor();
  await until(async () => (await table.locator('tbody tr').count()) === 1 && (await table.innerText()).includes('Initech'));
  if ((await api(gil, 'GET', `/files/${ids.plan}`)).status !== 404) throw new Error('gil still has the plan');
  // Search narrows the list.
  await page.getByLabel('Find').fill('nothing like this');
  await page.getByRole('status').getByText('Nothing matches.').waitFor();
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
