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

await step('five wrong passwords on Kim’s account: the security checkup warns, and opens Activity on failed sign-ins', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  const guess = await mk('stranger');
  await guess.goto(B);
  for (let i = 1; i <= 5; i++) {
    const t = await api(guess, 'POST', '/auth/login', { username: 'kim@acme.com', password: `guess-${i}-guess` });
    if (t.status !== 401) throw new Error(`try ${i}: ${t.status}`);
  }
  await guess.context().close();
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Security checkup' }).click();
  const item = page.getByRole('list', { name: 'Checkup' }).locator('li', { hasText: 'had many failed sign-ins this week' });
  await item.getByText('1 account had many failed sign-ins this week').waitFor();
  await item.getByText(/Kim Park \(5\)/).waitFor();
  await axe(page, 'checkup');
  await item.getByRole('button', { name: 'Go to Activity' }).click();
  await page.getByRole('tab', { name: 'Activity', selected: true }).waitFor();
  if (await page.getByLabel('Kind of activity').inputValue() !== 'sign-in.failed') throw new Error('not filtered');
  const rows = page.locator('table.activity tbody tr');
  await until(async () => (await rows.count()) === 5);
  const text = await page.locator('table.activity').innerText();
  if (!/Failed sign-in kim@acme\.com/.test(text) || /Signed in/.test(text)) throw new Error(text.slice(0, 300));
  await page.screenshot({ path: `${SP}/shots/checkup-fails-activity.png` });
});

await step('opening Activity from its tab again shows everything', async () => {
  await page.getByRole('tab', { name: 'Users' }).click();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await until(async () => (await page.getByLabel('Kind of activity').inputValue()) === '');
});

if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
