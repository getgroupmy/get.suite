import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
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
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
const quick = () => page.getByLabel('Quick add an event');
const said = () => page.locator('#cal-quick-what');
const dlg = () => page.getByRole('dialog', { name: 'New event' });
const settled = async (want) => { const end = Date.now() + 8000; let t = ''; while (Date.now() < end) { t = (await dlg().getByRole('list', { name: 'Invited guests' }).textContent()).replace(/×/g, '').trim(); if (t === want) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error(JSON.stringify(t)); };
const range = async () => (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 9 * 864e5}`)).body;
await step('colleagues to invite', async () => {
  for (const [local, name] of [['kim', 'Kim Park'], ['sam', 'Sam Lee'], ['sam.ortiz', 'Sam Ortiz']]) {
    const r = await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
    if (r.status !== 201) throw new Error(JSON.stringify(r));
  }
});
await step('"@kim" invites Kim; her name stays in the title; the preview says who', async () => {
  await page.goto(`${B}/calendar`);
  await quick().fill('Lunch with @kim tomorrow 1pm');
  await said().getByText('Lunch with Kim').waitFor();
  await said().getByText(/with Kim Park$/).waitFor();
  await quick().press('Enter');
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'Lunch with Kim') throw new Error('title');
  const chips = dlg().getByRole('list', { name: 'Invited guests' });
  // The window learns who's a colleague once the directory has loaded: wait for the chips to settle.
  await settled('Kim Park');
  await dlg().getByRole('button', { name: 'Save' }).click();
  await dlg().waitFor({ state: 'detached' });
  const e = (await range()).find((x) => x.title === 'Lunch with Kim');
  if (!e || JSON.stringify(e.guests.map((g) => g.email)) !== '["kim@acme.com"]') throw new Error(JSON.stringify(e));
});
await step('an address is a guest too, and leaves the title; two Sams: "@sam" stays as typed', async () => {
  await quick().fill('Kickoff with jo@client.example tomorrow 9am');
  await said().getByText(/^Kickoff ·/).waitFor();
  await said().getByText(/with jo@client\.example$/).waitFor();
  await quick().press('Enter');
  await dlg().waitFor();
  if (await dlg().getByLabel('Title').inputValue() !== 'Kickoff') throw new Error('title');
  await settled('jo@client.example · by email');
  await dlg().getByText(/People outside Workspace get an email invitation/).waitFor();
  await dlg().getByRole('button', { name: 'Cancel' }).click();
  await quick().fill('Sync with @sam tomorrow 3pm');
  await said().getByText('Sync with @sam').waitFor();
  if (/ · with /.test(await said().textContent())) throw new Error('guessed a Sam');
  await quick().fill('Sync with @Sam Ortiz tomorrow 3pm');
  await said().getByText(/with Sam Ortiz$/).waitFor();
  await page.screenshot({ path: `${SP}/shots/cal-quick-guests.png` });
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
