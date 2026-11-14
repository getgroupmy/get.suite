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
const max = await mk('max');
let code;
const gina = await mk('gina');
await step('Olivia makes a meeting link and goes back to Drive; a guest asks to join', async () => {
  code = (await api(page, 'POST', '/meet', { title: 'Client call' })).body.code;
  await page.goto(`${B}/drive`);
  await gina.goto(`${B}/meet/${code}`);
  await gina.getByLabel('Your name').fill('Gina Client');
  await gina.getByRole('button', { name: 'Ask to join' }).click();
  await gina.getByRole('heading', { name: 'Asking to join…' }).waitFor();
  await gina.getByText('Nobody’s in the meeting yet: Olivia Owner has been told you’re here.').waitFor();
  await gina.screenshot({ path: `${SP}/shots/meetknock-guest.png` });
}, gina);
await step('the bell tells Olivia someone is waiting; it opens the meeting, where she lets her in', async () => {
  await page.getByRole('button', { name: /^Notifications, \d+ new$/ }).click();
  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await panel.getByText('Gina Client is waiting to join “Client call”').waitFor();
  await page.screenshot({ path: `${SP}/shots/meetknockbell.png` });
  await panel.getByText('Gina Client is waiting to join “Client call”').click();
  await page.waitForURL(new RegExp(`/meet/${code}$`));
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('region', { name: 'Waiting to join' }).getByText('Gina Client').waitFor();
  await page.getByRole('button', { name: 'Let Gina Client in', exact: true }).click();
  await gina.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
