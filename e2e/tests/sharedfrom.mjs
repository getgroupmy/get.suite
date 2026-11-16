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

await step('Shared with me → From: narrow the list to what one person shared', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const leeId = (await api(page, 'POST', '/users', { local: 'lee', domain: 'acme.com', name: 'Lee Chan', password: 'password123' })).body.id;
  void kimId;
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  const up = (p, n) => p.evaluate(async (a) => (await fetch(`/api/files/upload?name=${encodeURIComponent(a)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json(), n);
  for (const n of ['Kim one.txt', 'Kim two.txt']) { const f = await up(kim, n); await api(kim, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: leeId, role: 'viewer' }] }); }
  const o = await up(page, 'Olivia plan.txt');
  await api(page, 'PUT', `/files/${o.id}/shares`, { shares: [{ user_id: leeId, role: 'viewer' }] });
  const lee = await mk('lee');
  await signIn(lee, 'lee@acme.com');
  await lee.goto(`${B}/drive/shared`);
  const rows = lee.locator('.files tbody tr');
  await until(async () => (await rows.count()) === 3);
  const from = lee.getByRole('group', { name: 'From' });
  await from.getByRole('button', { name: 'Kim Park · 2' }).click();
  await until(async () => (await rows.count()) === 2 && !(await rows.allInnerTexts()).join().includes('Olivia plan'));
  if (await from.getByRole('button', { name: 'Kim Park · 2' }).getAttribute('aria-pressed') !== 'true') throw new Error('not pressed');
  await axe(lee, 'from');
  await from.getByRole('button', { name: 'Olivia Owner · 1' }).click();
  await until(async () => (await rows.count()) === 1);
  await from.getByRole('button', { name: 'Everyone' }).click();
  await until(async () => (await rows.count()) === 3);
  await lee.screenshot({ path: `${SP}/shots/shared-from.png` });
});

await step('only one person shares with you: no From buttons', async () => {
  const kim = await mk('kim2');
  await signIn(kim, 'kim@acme.com');
  const f = await kim.evaluate(async () => (await fetch('/api/files/upload?name=solo.txt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: 'x' })).json());
  const me = (await api(page, 'GET', '/auth/me')).body.user;
  await api(kim, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: me.id, role: 'viewer' }] });
  await page.goto(`${B}/drive/shared`);
  await page.locator('.files tbody tr').first().waitFor();
  if (await page.getByRole('group', { name: 'From' }).count()) throw new Error('From shown for one person');
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
