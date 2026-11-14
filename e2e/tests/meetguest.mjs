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
await step('start a meeting; lobby shows the camera', async () => {
  await page.getByRole('link', { name: 'Meet', exact: true }).first().click();
  await page.getByLabel('Meeting name (optional)').fill('Standup');
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.waitForURL(/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  code = page.url().split('/meet/')[1];
  await page.getByRole('heading', { name: 'Standup' }).waitFor();
  await page.getByText('No one else is here yet').waitFor();
  await until(() => page.evaluate(() => { const v = document.querySelector('video[aria-label="Your camera"]'); return v && v.videoWidth > 0; }));
  await page.getByRole('button', { name: 'Join now' }).click();
  await page.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
});
const videoPlaying = (p, name) => p.evaluate((n) => { const v = document.querySelector(`video[aria-label="Video of ${n}"]`); return !!v && v.videoWidth > 0 && v.readyState >= 2; }, name);
const gina = await mk('gina');
await step('a guest opens the link without an account and asks to join', async () => {
  await gina.goto(`${B}/meet/${code}`);
  await gina.getByText('A meeting at Acme Trading').waitFor();
  await gina.getByRole('heading', { name: 'Standup' }).waitFor();
  if (!(await gina.getByRole('button', { name: 'Ask to join' }).isDisabled())) throw new Error('name not required');
  await gina.getByLabel('Your name').fill('Gina Client');
  await gina.getByRole('button', { name: 'Ask to join' }).click();
  await gina.getByRole('heading', { name: 'Asking to join…' }).waitFor();
}, gina);
await step('Olivia sees who is waiting and lets her in; they see each other', async () => {
  await page.getByRole('region', { name: 'Waiting to join' }).getByText('Gina Client').waitFor();
  await page.getByRole('button', { name: 'Let Gina Client in', exact: true }).click();
  await gina.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
  await until(() => videoPlaying(page, 'Gina Client (guest)'), 20000);
  await until(() => videoPlaying(gina, 'Olivia Owner'), 20000);
  if (await page.getByRole('region', { name: 'Waiting to join' }).count()) throw new Error('banner stays');
  if (await gina.getByRole('button', { name: 'Record the meeting' }).count()) throw new Error('guest can record');
  await gina.getByRole('button', { name: 'Chat', exact: true }).click();
  await gina.getByLabel('Send a message to everyone').fill('Hi all');
  await gina.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Chat, 1 new' }).click();
  await page.getByRole('complementary', { name: 'Meeting chat' }).getByText('Hi all').waitFor();
  await page.getByRole('complementary', { name: 'Meeting chat' }).getByText('Gina Client (guest)').waitFor();
}, gina);
const bob = await mk('bob');
await step('another guest is turned away', async () => {
  await bob.goto(`${B}/meet/${code}`);
  await bob.getByLabel('Your name').fill('Bob Nope');
  await bob.getByRole('button', { name: 'Ask to join' }).click();
  await page.getByRole('button', { name: 'Don’t let Bob Nope in' }).click();
  await bob.getByRole('heading', { name: 'You weren’t let in' }).waitFor();
  await bob.getByText('Nobody in the meeting let you in').first().waitFor();
}, bob);
await step('admin turns guests off: the link no longer works for them; Sign in still does', async () => {
  const r = await api(page, 'PATCH', '/orgs/current', { meet_guests: false });
  if (r.body.meet_guests !== false) throw new Error(JSON.stringify(r.body));
  await bob.goto(`${B}/meet/${code}`);
  await bob.getByRole('heading', { name: 'Can’t join this meeting' }).waitFor();
  await api(page, 'PATCH', '/orgs/current', { meet_guests: true });
  await bob.goto(`${B}/meet/${code}`);
  await bob.getByRole('button', { name: 'Sign in' }).click();
  await bob.getByRole('button', { name: /^Sign in/ }).first().waitFor();
  await bob.getByLabel(/email|username/i).first().waitFor();
}, bob);
await step('Admin → Company settings has the switch', async () => {
  const p2 = await mk('admin');
  await signIn(p2, 'olivia@acme.com');
  await p2.goto(`${B}/admin`);
  await p2.getByRole('tab', { name: 'Company settings' }).or(p2.getByRole('button', { name: 'Company settings' })).first().click();
  await p2.getByText('Let guests without an account ask to join video meetings').waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
