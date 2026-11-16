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
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
};

await step('access ending in 2 days: Kim and Olivia are both told, in the bell', async () => {
  const kim = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body;
  const f = await page.evaluate(async () => (await fetch('/api/files/upload?name=Budget%20draft.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json());
  const r = await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kim.id, role: 'editor', expires_at: Date.now() + 2 * 864e5 }] });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  const k = await mk('kim');
  await signIn(k, 'kim@acme.com');
  // Checked every minute on the server.
  await until(async () => ((await api(k, 'GET', '/notifications')).body?.items || []).some((n) => /^Your access to “Budget draft\.txt” ends /.test(n.title)), 75000);
  await k.goto(`${B}/home`);
  await k.getByRole('button', { name: /^Notifications/ }).first().click();
  await k.getByText(/^Your access to “Budget draft\.txt” ends /).first().waitFor();
  await k.getByText('Shared by Olivia Owner until then. Ask them if you still need it.').first().waitFor();
  await page.goto(`${B}/home`);
  await page.getByRole('button', { name: /^Notifications/ }).first().click();
  await page.getByText(/^Kim Park's access to “Budget draft\.txt” ends /).first().waitFor();
  await page.getByText('Open its Share window to give them longer.').first().waitFor();
});

await step('Kim asks for longer from Shared with me; Olivia gives 30 more days', async () => {
  const k = await mk('kim2');
  await signIn(k, 'kim@acme.com');
  await k.goto(`${B}/drive/shared`);
  const row = k.locator('.files tbody tr', { hasText: 'Budget draft.txt' });
  await row.getByText(/· until /).waitFor();
  await row.getByRole('button', { name: /^Actions for/ }).click();
  await k.getByRole('menuitem', { name: 'Ask for longer access' }).click();
  await k.getByText('Asked Olivia Owner to let you keep “Budget draft.txt” longer').waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Access requests/ }).click();
  const d = page.getByRole('dialog').filter({ hasText: 'asks to keep' });
  await d.getByText(/asks to keep\s+Budget draft\.txt after /).waitFor();
  await axe(page, 'longer request');
  await d.getByRole('button', { name: 'Give 30 more days' }).click();
  await page.getByText('Kim Park can keep Budget draft.txt longer').waitFor();
  const f = ((await api(page, 'GET', '/files')).body || []).find((x) => x.name === 'Budget draft.txt');
  const kim = ((await api(page, 'GET', `/files/${f.id}/shares`)).body || []).find((x) => x.username === 'kim@acme.com');
  const days = (kim.expires_at - Date.now()) / 864e5;
  if (!(days > 29.9 && days <= 30)) throw new Error(`ends in ${days} days`);
  await until(async () => ((await api(k, 'GET', '/notifications')).body?.items || []).some((n) => /^You can keep “Budget draft\.txt” until /.test(n.title)));
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
