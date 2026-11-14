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

await step('Company settings: shares with other companies last at most 30 days', async () => {
  const r = await api(page, 'POST', '/orgs', { name: 'Globex', domain: 'globex.com', admin_name: 'Gil Green', admin_local: 'gil', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).click();
  const sel = page.getByLabel('Files shared with people at other companies stay shared for');
  await sel.selectOption({ label: 'At most 30 days' });
  await page.getByText('Shares with other companies now end after 30 days').waitFor();
  await page.getByText(/each share with someone outside gets an end date at most 30 days ahead/).waitFor();
  await axe(page, 'company setting');
});

await step('sharing with Gil (another company) in the Share window: told, and it ends in 30 days', async () => {
  const f = await page.evaluate(async () => (await fetch('/api/files/upload?name=Joint%20plan.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json());
  await page.goto(`${B}/drive`);
  const row = page.locator('.files tbody tr', { hasText: 'Joint plan.txt' });
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Share “Joint plan.txt”' });
  await d.getByLabel('Email address').fill('gil@globex.com');
  await d.getByRole('button', { name: 'Add', exact: true }).click();
  await d.getByText(/Your company ends shares with people at other companies after at most 30 days/).waitFor();
  await d.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Sharing updated').waitFor();
  const shares = (await api(page, 'GET', `/files/${f.id}/shares`)).body;
  const gil = shares.find((s) => s.username === 'gil@globex.com');
  const days = (gil.expires_at - Date.now()) / 864e5;
  if (!(days > 29.9 && days <= 30)) throw new Error(`ends in ${days} days`);
  // The Share window shows that date now.
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
  const until = await page.getByLabel('Access for Gil Green ends').inputValue();
  if (!until) throw new Error('no end date shown');
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
