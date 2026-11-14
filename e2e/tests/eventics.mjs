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
const day = 864e5;
const dayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const fs = await import('node:fs');
const unfold = (s) => s.replace(/\r\n[ \t]/g, '');
await step('Download (.ics) in an event: a calendar file with its time, place, notes and guest', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const start = dayStart + day + 10 * 36e5;
  const r = await api(page, 'POST', '/events', { title: 'Supplier call', location: 'Room 2', description: 'Prices for 2027', start, end: start + 36e5, guests: ['kim@acme.com'] });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  await page.goto(`${B}/calendar`);
  await page.getByRole('radio', { name: 'Month' }).click();
  await page.locator('.month .chip', { hasText: 'Supplier call' }).first().click();
  const d = page.getByRole('dialog', { name: 'Edit event' });
  const [dl] = await Promise.all([page.waitForEvent('download'), d.getByRole('link', { name: 'Download (.ics)' }).click()]);
  if (dl.suggestedFilename() !== 'Supplier call.ics') throw new Error(dl.suggestedFilename());
  const ics = unfold(fs.readFileSync(await dl.path(), 'utf8'));
  for (const re of [/SUMMARY:Supplier call/, /LOCATION:Room 2/, /DESCRIPTION:Prices for 2027/, /ATTENDEE[^:]*:mailto:kim@acme\.com/, /DTSTART:\d{8}T\d{6}Z/]) if (!re.test(ics)) throw new Error(`${re} not in ${ics}`);
  const utc = new Date(start).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  if (!ics.includes(`DTSTART:${utc}`)) throw new Error(`start ${utc}`);
  await d.getByRole('button', { name: 'Cancel' }).click();
});
await step('a guest can download it from the invitation', async () => {
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const k = await kctx.newPage();
  await k.goto(B); await k.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'kim@acme.com', password: 'password123' }) }));
  await k.goto(`${B}/calendar`);
  await k.getByRole('radio', { name: 'Month' }).click();
  await k.locator('.month .chip', { hasText: 'Supplier call' }).first().click();
  const d = k.getByRole('dialog', { name: 'Supplier call' });
  const [dl] = await Promise.all([k.waitForEvent('download'), d.getByRole('link', { name: 'Download this event (.ics)' }).click()]);
  if (!/ORGANIZER;CN="Olivia Owner":mailto:olivia@acme\.com/.test(unfold(fs.readFileSync(await dl.path(), 'utf8')))) throw new Error('organizer');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
