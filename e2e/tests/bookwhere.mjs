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
let url, visitor;
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
await step('a booking page with a video meeting for each booking', async () => {
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'New booking page' }).click();
  await dlg.getByLabel('Title').fill('Demo');
  for (const d of ['Sun', 'Sat']) await dlg.getByLabel(d, { exact: true }).check();
  await dlg.getByLabel('From', { exact: true }).fill('00:00');
  await dlg.getByLabel('To', { exact: true }).fill('23:30');
  await dlg.getByLabel('At least this much notice').selectOption({ label: 'None' });
  await dlg.getByLabel('Where').selectOption('video');
  await dlg.getByRole('button', { name: 'Create' }).click();
  await dlg.getByText('Demo').first().waitFor();
  const saved = (await api(page, 'GET', '/bookings')).body[0];
  if (saved.where_kind !== 'video') throw new Error(JSON.stringify(saved));
  url = saved.url;
  await page.keyboard.press('Escape');
});
await step('the visitor sees it’s a video meeting, books, and gets the link', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  visitor = await ctx.newPage();
  visitor.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await visitor.goto(url.replace(/^https?:\/\/[^/]+/, B));
  await visitor.getByText(/30 minutes · 📹 Video meeting/).waitFor();
  await visitor.getByRole('tab').nth(1).click();
  await visitor.getByRole('group', { name: /^Times on/ }).getByRole('button').first().click();
  await visitor.getByLabel('Your name').fill('Vic Video');
  await visitor.getByLabel('Your email').fill('vic@example.org');
  await visitor.getByRole('button', { name: 'Book' }).click();
  await visitor.getByRole('heading', { name: 'You’re booked' }).waitFor();
  const link = visitor.getByRole('link', { name: /\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}\?name=Vic%20Video$/ });
  await link.waitFor();
  await visitor.screenshot({ path: `${SP}/shots/bookwhere.png` });
  const code = (await link.innerText()).split('/meet/')[1].split('?')[0];
  const ev = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 3 * 864e5}`)).body.find((e) => e.title === 'Demo: Vic Video');
  if (ev?.meet_code !== code) throw new Error(JSON.stringify(ev));
});
await step('the link opens the meeting with their name filled in', async () => {
  const href = await visitor.getByRole('link', { name: /\/meet\// }).getAttribute('href');
  await visitor.goto(href.replace(/^https?:\/\/[^/]+/, B));
  await until(async () => (await visitor.getByLabel('Your name').inputValue().catch(() => '')) === 'Vic Video', 15000);
  await visitor.screenshot({ path: `${SP}/shots/bookwhere-join.png` });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
