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
let url, start;
await step('a booking page for a class: two people at a time (set in the editor)', async () => {
  const made = (await api(page, 'POST', '/bookings', { title: 'Pottery class', duration: 60, days: [0, 1, 2, 3, 4, 5, 6], from_min: 540, to_min: 600, tz: 'UTC', days_ahead: 3, notice_hours: 0 })).body;
  url = made.url.replace(/^https?:\/\/[^/]+/, B);
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Booking pages' }).click();
  const dlg = page.getByRole('dialog', { name: 'Booking pages' });
  await dlg.getByRole('button', { name: 'Change Pottery class' }).click();
  await dlg.getByLabel('People at a time').fill('2');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await api(page, 'GET', '/bookings')).body.find((p) => p.title === 'Pottery class').seats === 2);
});
const visit = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const v = await ctx.newPage();
  v.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  await v.goto(url);
  await v.getByRole('heading', { name: 'Pottery class' }).waitFor();
  await v.getByText(/up to 2 people/).waitFor();
  return v;
};
const book = async (v, who) => {
  await v.getByRole('group', { name: /^Times on/ }).getByRole('button').first().click();
  await v.getByLabel('Your name').fill(who);
  await v.getByLabel('Your email').fill(`${who.toLowerCase()}@example.org`);
  await v.getByRole('button', { name: 'Book' }).click();
  await v.getByRole('heading', { name: 'You’re booked' }).waitFor();
};
await step('two visitors book the same time: "2 places left", then "1 place left"; one event with both', async () => {
  const a = await visit('ana');
  const firstTime = a.getByRole('group', { name: /^Times on/ }).getByRole('button').first();
  await firstTime.getByText('2 places left').waitFor();
  await a.screenshot({ path: `${SP}/shots/booking-group.png` });
  await axe(a, 'booking page');
  await book(a, 'Ana');
  const b = await visit('ben');
  await b.getByRole('group', { name: /^Times on/ }).getByRole('button').first().getByText('1 place left').waitFor();
  await book(b, 'Ben');
  const evs = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 5 * 864e5}`)).body.filter((e) => e.title === 'Pottery class');
  if (evs.length !== 1 || evs[0].guests.map((g) => g.email).sort().join() !== 'ana@example.org,ben@example.org') throw new Error(JSON.stringify(evs));
});
await step('full: that time is no longer offered', async () => {
  const c = await visit('cy');
  const times = await c.getByRole('group', { name: /^Times on/ }).getByRole('button').allInnerTexts();
  if (times.some((t) => /place/.test(t) && /left/.test(t) && !/2 places left/.test(t))) throw new Error(times.join('|'));
  const evs = (await api(page, 'GET', `/events?from=${Date.now() - 864e5}&to=${Date.now() + 5 * 864e5}`)).body.filter((e) => e.title === 'Pottery class');
  const taken = evs[0].start;
  const offered = await c.evaluate(async (t) => (await (await fetch(`/api/public/book/${t}`)).json()).days.flatMap((d) => d.slots), url.split('/b/')[1]);
  if (offered.includes(taken)) throw new Error('still offered');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
