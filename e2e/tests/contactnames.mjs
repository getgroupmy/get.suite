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
// Names with a comma, quotes or brackets in them ("Doe, Jo", Outlook's way; Jo Park (Sales)) stay whole
// when a group is edited and when its people are put on an email's address line.
import { createRequire } from 'node:module';
const addressparser = createRequire(`${ROOT}/server/package.json`)('nodemailer/lib/addressparser'); // as the server reads an address line
const PEOPLE = [{ name: 'Doe, Jo', email: 'jo@example.com' }, { name: 'Ann "Nan" Lee', email: 'ann@example.com' }, { name: 'Jo Park (Sales)', email: 'park@example.com' }, { name: 'Acme: Billing', email: 'billing@example.com' }, { name: 'Ben Best', email: 'ben@example.com' }];
const same = (list) => JSON.stringify(list.map((p) => [p.name, p.email || p.address])) === JSON.stringify(PEOPLE.map((p) => [p.name, p.email]));
let group;
await step('setup: a group of people with commas, quotes and brackets in their names', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  group = (await api(page, 'POST', '/contacts/groups', { name: 'Clients', members: PEOPLE })).body;
  if (!same(group.members)) throw new Error(JSON.stringify(group.members));
});
await step('editing the group keeps every name as it was', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: 'Groups' }).click();
  await page.getByRole('button', { name: 'Edit Clients' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit group' });
  await dialog.getByText('5 people').waitFor();
  await page.screenshot({ path: `${SP}/shots/group-names.png` });
  await dialog.getByLabel('Group name').fill('Clients 2026');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached' });
  const g = (await api(page, 'GET', '/contacts/groups')).body.find((x) => x.id === group.id);
  if (g.name !== 'Clients 2026' || !same(g.members)) throw new Error(JSON.stringify(g.members)); // (was "Doe Jo", "Ann Nan Lee")
});
await step('emailing the group: the address line has every name whole, as a mail program reads it', async () => {
  const seen = [];
  const note = (f) => { if (f === page.mainFrame()) seen.push(f.url()); };
  page.on('framenavigated', note);
  await page.getByRole('button', { name: 'Email Clients 2026' }).click();
  await page.waitForFunction(() => location.pathname === '/mail');
  page.off('framenavigated', note);
  const hit = [...seen, page.url()].find((u) => /\/mail\?compose=/.test(u));
  if (!hit) throw new Error(`no compose link: ${seen.join(' ')}`);
  const line = new URL(hit).searchParams.get('compose');
  const read = addressparser(line, { flatten: true });
  if (!same(read)) throw new Error(`${line} → ${JSON.stringify(read)}`); // (was "Jo Park" and "Billing")
});
if (errors.length) { console.log('ERRORS', errors.join(' | ')); failed++; }
await browser.close();
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
