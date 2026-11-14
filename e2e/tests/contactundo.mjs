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
let kim;
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
let dm;
const dialog = () => page.getByRole('dialog', { name: 'Undo changes' });
const names = async () => (await api(page, 'GET', '/contacts')).body.map((c) => c.name).sort().join();
let marker;
await step('a bad afternoon in Contacts, undone back to a time of your own', async () => {
  for (const [name, email] of [['Ada Lovelace', 'ada@example.com'], ['Grace Hopper', 'grace@example.com']]) await api(page, 'POST', '/contacts', { name, email });
  const ids = (await api(page, 'GET', '/contacts')).body;
  const ada = ids.find((c) => c.name === 'Ada Lovelace').id, grace = ids.find((c) => c.name === 'Grace Hopper').id;
  // Go back to the start of the next minute (the picker works in minutes): wait for it to pass.
  const next = new Date(Math.floor(Date.now() / 60000) * 60000 + 60000);
  await page.waitForTimeout(next.getTime() - Date.now() + 1500);
  const pad = (n) => String(n).padStart(2, '0');
  marker = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
  await page.goto(`${B}/contacts`);
  await page.getByText('Ada Lovelace').first().waitFor();
  await api(page, 'PATCH', `/contacts/${ada}`, { name: 'Ada WRONG', email: 'wrong@example.com' });
  await api(page, 'DELETE', `/contacts/${grace}`);
  await api(page, 'POST', '/contacts', { name: 'Junk Import' });
  await page.reload();
  await page.getByText('Ada WRONG').first().waitFor();
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await dialog().getByText(/contacts have changed since then/).waitFor(); // 10 minutes ago: all of them
  await dialog().getByLabel('A time of my own').check();
  await dialog().getByLabel('Date and time to go back to').fill(marker);
  await dialog().getByText('3 contacts have changed since then and will go back as they were.').waitFor();
  await page.screenshot({ path: `${SP}/shots/contacts-undo.png` });
  await dialog().getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undid changes to 3 contacts').waitFor();
  await page.getByText('Grace Hopper').first().waitFor();
  await page.getByText('Ada Lovelace').first().waitFor();
  if (await page.getByText('Junk Import').count()) throw new Error('junk still listed');
  if ((await names()) !== 'Ada Lovelace,Grace Hopper') throw new Error(await names());
});
await step('a time in the future is refused; the junk contact is in the Trash', async () => {
  await page.getByRole('button', { name: 'Undo changes' }).click();
  await dialog().getByLabel('A time of my own').check();
  await dialog().getByText('Pick a date and time in the last 30 days.').waitFor();
  const d = new Date(Date.now() + 60000), pad = (n) => String(n).padStart(2, '0');
  await dialog().getByLabel('Date and time to go back to').fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  await dialog().getByText('Pick a date and time in the last 30 days.').waitFor();
  await dialog().getByLabel('10 minutes ago').check();
  await dialog().getByText(/contacts? ha(s|ve) changed since then/).waitFor(); // the undo itself is a change
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  // The junk contact is in the trash.
  const trash = (await api(page, 'GET', '/contacts/trash')).body.contacts.map((t) => t.name);
  if (!trash.includes('Junk Import')) throw new Error(trash.join());
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
