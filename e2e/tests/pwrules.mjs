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
await step('an admin sets password rules in Company settings', async () => {
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Company settings' }).or(page.getByRole('button', { name: 'Company settings' })).first().click();
  const card = page.getByRole('region', { name: 'Password rules' }).or(page.locator('.card', { has: page.getByRole('heading', { name: 'Password rules' }) })).first();
  await card.getByLabel('Shortest password').selectOption('12');
  await page.getByText('Password rules saved').first().waitFor();
  await card.getByLabel('Letters and numbers').check();
  await card.getByLabel(/Nothing easy to guess/).check();
  await card.getByLabel('Passwords expire').selectOption('90');
  await page.getByText('Passwords now expire after 90 days').waitFor();
  const o = (await api(page, 'GET', '/orgs/current')).body.password_rules;
  if (o.min !== 12 || !o.mix || !o.common || o.max_days !== 90) throw new Error(JSON.stringify(o));
});
await step('they apply to new people, and to choosing your own password', async () => {
  const bad = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password1234' });
  if (bad.status !== 400 || !/easy to guess/.test(bad.body.error)) throw new Error(JSON.stringify(bad));
  const ok = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'river-kettle-49', must_change_password: true });
  if (ok.status !== 201) throw new Error(JSON.stringify(ok));
  const kim = await mk('kim');
  await signIn(kim, 'kim@acme.com');
  await kim.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'river-kettle-49' }) }));
  await kim.goto(B);
  await kim.getByText('Use at least 12 characters, with letters and numbers, and nothing easy to guess.').waitFor();
  await kim.getByLabel('Password you were given').fill('river-kettle-49');
  await kim.getByLabel('New password', { exact: true }).fill('kimpark2026x');
  await kim.getByLabel('New password again').fill('kimpark2026x');
  await kim.getByRole('button', { name: 'Save and continue' }).click();
  await kim.getByText('Don’t use your own name or address as your password').waitFor();
  await kim.getByLabel('New password', { exact: true }).fill('green-teapot-77');
  await kim.getByLabel('New password again').fill('green-teapot-77');
  await kim.getByRole('button', { name: 'Save and continue' }).click();
  await kim.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
