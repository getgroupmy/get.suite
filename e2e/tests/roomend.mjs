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
  p.on('console', (m) => m.type() === 'error' && !/40[0-49]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
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
const tomorrowAt = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.getTime(); };
const dayIso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const t0 = Date.now();
const time = (t) => page.evaluate((x) => new Date(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), t);
let ids = {};
await step('Olivia books the Huddle now; the Boardroom has a meeting of someone else', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  for (const name of ['Boardroom', 'Huddle']) ids[name] = (await api(page, 'POST', '/rooms', { name })).body.id;
  await api(page, 'POST', '/events', { title: 'Later', start: t0 + 60 * 6e4, end: t0 + 120 * 6e4, rooms: [ids.Huddle] });
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Rooms now' }).click();
  const d = page.getByRole('dialog', { name: 'Rooms now' });
  await d.getByRole('listitem', { name: 'Huddle' }).getByRole('button', { name: 'Book now' }).click();
  await d.getByRole('listitem', { name: 'Huddle' }).getByRole('button', { name: 'End now' }).waitFor();
});
await step('+15 min runs on; again until the next booking is refused', async () => {
  const d = page.getByRole('dialog', { name: 'Rooms now' });
  const h = d.getByRole('listitem', { name: 'Huddle' });
  await h.getByRole('button', { name: '+15 min' }).click();
  await page.getByText(/^Huddle: yours until/).waitFor();
  await h.getByText(/^In use until .*Meeting in Huddle/).waitFor();
  await h.getByRole('button', { name: '+15 min' }).click();
  await page.getByText(/^Huddle: yours until/).nth(0).waitFor();
  await h.getByRole('button', { name: '+15 min' }).click();
  await page.getByText('Huddle is booked after you: Later').waitFor();
  await page.screenshot({ path: `${SP}/shots/roomend.png` });
});
await step('End now gives the room back', async () => {
  const d = page.getByRole('dialog', { name: 'Rooms now' });
  const h = d.getByRole('listitem', { name: 'Huddle' });
  await h.getByRole('button', { name: 'End now' }).click();
  await page.getByText('Huddle is free for others now').waitFor();
  await h.getByText(`Free until ${await time(t0 + 60 * 6e4)}`).waitFor();
  await h.getByRole('button', { name: 'Book now' }).waitFor();
  const ev = (await api(page, 'GET', `/events?from=${t0 - 36e5}&to=${t0 + 36e5}`)).body.find((e) => e.title === 'Meeting in Huddle');
  if (!ev || ev.end > Date.now()) throw new Error(JSON.stringify(ev));
});
console.log(errors.length ? `ERRORS ${errors.join(' / ')}` : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
