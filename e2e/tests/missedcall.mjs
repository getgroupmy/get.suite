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
const videoPlaying = (p, name) => p.evaluate((n) => { const v = document.querySelector(`video[aria-label="Video of ${n}"]`); return !!v && v.videoWidth > 0 && v.readyState >= 2; }, name);
let kim, dm, meetPage;
await step('Olivia calls Kim from their direct messages and waits in the meeting', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive`);
  await page.goto(`${B}/chat/${dm}`);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Start a video meeting' }).click();
  meetPage = await popup;
  await meetPage.getByRole('button', { name: 'Join now' }).click();
  await meetPage.getByRole('toolbar', { name: 'Meeting controls' }).waitFor();
});
await step('Kim doesn’t answer: after the ringing stops, a missed call in their chat and in Kim’s bell', async () => {
  await kim.getByText('📞 Olivia Owner is calling you').waitFor({ timeout: 15000 });
  await page.getByText('📞 Missed call from Olivia Owner').waitFor({ timeout: 50000 });
  await kim.getByRole('button', { name: /^Notifications, \d+ new$/ }).click();
  await kim.getByRole('dialog', { name: 'Notifications' }).getByText('📞 Missed call from Olivia Owner').waitFor();
  await kim.screenshot({ path: `${SP}/shots/missedcall.png` });
  await kim.getByRole('dialog', { name: 'Notifications' }).getByText('📞 Missed call from Olivia Owner').click();
  await kim.waitForURL(new RegExp(`/chat/${dm}$`));
});
await step('Kim presses Call back on the missed call: Olivia is rung', async () => {
  const popup = kim.waitForEvent('popup');
  await kim.getByRole('button', { name: 'Call back' }).click();
  await (await popup).waitForURL(/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  await page.getByText('📞 Kim Park is calling you').waitFor({ timeout: 15000 });
  await kim.screenshot({ path: `${SP}/shots/callback.png` });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
