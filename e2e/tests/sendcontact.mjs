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
let dm, kim;
await step('send a contact to Kim from Contacts', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await api(page, 'POST', '/contacts', { name: 'Pat Plumber', email: 'pat@plumb.example', phone: '+60 3 1234', company: 'Plumb Co', title: 'Owner', notes: 'Owes us money' });
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'Send Pat Plumber in Chat' }).click();
  const d = page.getByRole('dialog', { name: 'Send Pat Plumber in Chat' });
  await d.getByLabel('To').selectOption({ label: 'Kim Park' });
  await d.getByLabel('Add a message (optional)').fill('Our plumber, very good');
  await d.getByRole('button', { name: 'Send' }).click();
  await d.waitFor({ state: 'detached' });
  await page.getByText('Pat Plumber sent to Kim Park').waitFor();
});
await step('Kim sees the card and adds it to her contacts', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${dm}`);
  const card = kim.getByRole('group', { name: 'Contact: Pat Plumber' });
  await card.waitFor();
  const txt = await card.textContent();
  if (!/Owner · Plumb Co/.test(txt) || !/pat@plumb.example/.test(txt) || !/\+60 3 1234/.test(txt) || /Owes/.test(txt)) throw new Error(txt);
  await kim.getByText('Our plumber, very good').waitFor();
  await kim.screenshot({ path: `${SP}/shots/contact-card.png` });
  await card.getByRole('button', { name: 'Add to my contacts' }).click();
  await kim.getByText('Pat Plumber added to your contacts').waitFor();
  await card.getByRole('button', { name: '✓ In your contacts' }).waitFor();
  await kim.goto(`${B}/contacts`);
  await kim.getByRole('button', { name: 'Edit Pat Plumber' }).waitFor();
  // Again (after a reload): it's already there, not a second one.
  await kim.goto(`${B}/chat/${dm}`);
  await kim.getByRole('group', { name: 'Contact: Pat Plumber' }).getByRole('button', { name: 'Add to my contacts' }).click();
  await kim.getByText('Pat Plumber is already in your contacts').waitFor();
  const n = (await api(kim, 'GET', '/contacts')).body.filter((c) => c.name === 'Pat Plumber').length;
  if (n !== 1) throw new Error(`${n} copies`);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
