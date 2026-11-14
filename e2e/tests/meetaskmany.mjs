import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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
let code, ev;
const g = (i) => `guest${i}`;
await step('an event with 10 colleagues invited; Olivia in its meeting', async () => {
  for (let i = 1; i <= 10; i++) await api(page, 'POST', '/users', { local: g(i), domain: 'acme.com', name: `Guest ${i}`, password: 'password123' });
  code = (await api(page, 'POST', '/meet', { title: 'All hands' })).body.code;
  const start = Date.now();
  ev = (await api(page, 'POST', '/events', { title: 'All hands', start, end: start + 3600e3, meet_code: code, guests: Array.from({ length: 10 }, (_, i) => `${g(i + 1)}@acme.com`) })).body;
  await page.goto(`${B}/meet/${code}`);
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await page.getByRole('button', { name: 'People', exact: true }).click();
});
const all = () => page.getByRole('button', { name: /^📞 Ring everyone invited who isn’t here/ });
await step('one press rings all ten (8 at a time behind the scenes)', async () => {
  await all().waitFor();
  if (!/\(10\)$/.test(await all().innerText())) throw new Error(await all().innerText());
  await all().click();
  await page.getByText('Ringing Guest 1, Guest 10, Guest 2 and 7 more…').waitFor();
  const other = await mk('g10');
  await signIn(other, `${g(10)}@acme.com`);
  const bell = await other.evaluate(async () => (await fetch('/api/notifications', { headers: { 'x-requested-with': 'nas-workspace' } })).text());
  if (!bell.includes('Olivia Owner is asking you to join “All hands”')) throw new Error('the tenth was not rung');
});
await step('a guest says no: within half a minute the count follows', async () => {
  const one = await mk('g1');
  await signIn(one, `${g(1)}@acme.com`);
  const r = await one.evaluate(async (id) => (await fetch(`/api/events/${id}/rsvp`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'no' }) })).status, ev.id);
  if (r !== 200) throw new Error(`rsvp ${r}`);
  await until(async () => /\(9\)$/.test(await all().innerText()), 40000);
});
await step('if a later batch fails, it says who was rung and that the rest weren’t', async () => {
  let n = 0;
  await page.route('**/api/meet/*/invite', (route) => (++n === 2 ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'The server is busy' }) }) : route.continue()));
  await all().click();
  await page.getByText(/^Ringing Guest 10, Guest 2, Guest 3 and 5 more, but the others couldn’t be rung: The server is busy$/).waitFor();
  await page.unroute('**/api/meet/*/invite');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
