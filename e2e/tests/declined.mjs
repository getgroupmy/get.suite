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
let ev, kim;
await step('Kim invites Olivia to two events; Olivia says No to one', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com'); await kim.goto(`${B}/calendar`);
  const start = Math.ceil(Date.now() / 36e5) * 36e5 + 36e5;
  await api(kim, 'POST', '/events', { title: 'Lunch and learn', start, end: start + 36e5, guests: ['olivia@acme.com'] });
  const no = (await api(kim, 'POST', '/events', { title: 'Budget review', start: start + 2 * 36e5, end: start + 3 * 36e5, guests: ['olivia@acme.com'] })).body;
  await api(page, 'POST', `/events/${no.id}/rsvp`, { status: 'no' });
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Budget review', { exact: true }).first().waitFor();
  await page.getByText('Lunch and learn', { exact: true }).first().waitFor();
});
await step('untick Show declined events: Budget review goes; it stays so after a reload', async () => {
  await page.getByLabel('Show declined events').uncheck();
  await until(async () => (await page.getByText('Budget review', { exact: true }).count()) === 0);
  await page.getByText('Lunch and learn', { exact: true }).first().waitFor();
  await page.screenshot({ path: `${SP}/shots/declined.png` });
  await page.reload();
  await page.getByRole('radio', { name: 'Schedule' }).click();
  await page.getByText('Lunch and learn', { exact: true }).first().waitFor();
  if (await page.getByText('Budget review', { exact: true }).count()) throw new Error('back after reload');
  if (await page.getByLabel('Show declined events').isChecked()) throw new Error('setting not kept');
});
await step('tick it again: back, faded', async () => {
  await page.getByLabel('Show declined events').check();
  await page.getByText('Budget review', { exact: true }).first().waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
