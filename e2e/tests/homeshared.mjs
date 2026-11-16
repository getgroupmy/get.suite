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

await step('Home → Shared with you: what Olivia just shared with Kim, by whom, and it opens', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const up = (n) => page.evaluate(async (a) => (await fetch(`/api/files/upload?name=${encodeURIComponent(a)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json(), n);
  const brief = await up('Project brief.txt');
  const budget = await up('Budget.csv');
  await api(page, 'PUT', `/files/${brief.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'PUT', `/files/${budget.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/home`);
  const card = kim.getByRole('region', { name: 'Shared with you' });
  await card.waitFor();
  const items = await card.locator('li .home-item').allInnerTexts();
  if (items.join('|') !== 'Budget.csv|Project brief.txt') throw new Error(items.join('|'));
  await card.locator('li', { hasText: 'Project brief.txt' }).getByText('Olivia Owner · can edit').waitFor();
  await card.locator('li', { hasText: 'Budget.csv' }).getByText('Olivia Owner · can view').waitFor();
  await kim.screenshot({ path: `${SP}/shots/home-shared.png` });
  await axe(kim, 'home shared');
  await card.getByRole('link', { name: 'Shared with you' }).click();
  await kim.waitForURL(/\/drive\/shared$/);
  // In Customize, by name.
  await kim.goto(`${B}/home`);
  await kim.getByRole('button', { name: 'Customize' }).click();
  await kim.getByRole('dialog', { name: 'Customize Home' }).getByText('Shared with you').waitFor();
});

await step('Drive → Shared with me: newest shared first, with who shared it and when', async () => {
  const kim = await mk('kim2');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive/shared`);
  const rows = kim.locator('.files tbody tr');
  await until(async () => (await rows.count()) === 2);
  const names = await rows.locator('.name-text').allInnerTexts();
  if (!names[0].startsWith('Budget.csv') || !names[1].startsWith('Project brief.txt')) throw new Error(names.join(' | '));
  await rows.first().getByText(/· Olivia Owner shared it /).waitFor();
  await axe(kim, 'shared with me');
});

await step('Remove from Shared with me: gone for Kim, and from Olivia’s Shared by me', async () => {
  const kim = await mk('kim3');
  await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive/shared`);
  const rows = kim.locator('.files tbody tr');
  await until(async () => (await rows.count()) === 2);
  await rows.filter({ hasText: 'Budget.csv' }).getByRole('button', { name: 'Actions for Budget.csv' }).click();
  await kim.getByRole('menuitem', { name: 'Remove from Shared with me' }).click();
  await kim.getByText('“Budget.csv” removed: ask its owner if you need it again').waitFor();
  await until(async () => (await rows.count()) === 1);
  await page.goto(`${B}/drive/sharedbyme`);
  const mine = page.locator('.files tbody tr');
  await until(async () => (await mine.count()) === 1 && (await mine.first().innerText()).includes('Project brief.txt'));
});

await step('Olivia, who shared them, has no such card', async () => {
  await page.goto(`${B}/home`);
  await page.getByRole('region', { name: 'Recent files' }).waitFor();
  if (await page.getByRole('region', { name: 'Shared with you' }).count()) throw new Error('owner sees the card');
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
