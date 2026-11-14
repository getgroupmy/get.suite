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
let dm, kim;
await step('Olivia messages Kim; it says Seen once Kim opens it', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: kimId })).body.id;
  await page.goto(`${B}/chat/${dm}`);
  await page.getByLabel('Message', { exact: true }).fill('Lunch at 1?');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Lunch at 1?').waitFor();
  await page.waitForTimeout(800);
  if (await page.locator('.seen-mark').count()) throw new Error('seen before Kim looked');
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${dm}`);
  await kim.getByText('Lunch at 1?').waitFor();
  await page.locator('.seen-mark').getByText('Seen').waitFor();
  if (await kim.locator('.seen-mark').count()) throw new Error('Kim sees Seen on Olivia\'s message');
});
await step('only under the latest of your messages; a new one waits to be seen', async () => {
  await kim.goto(`${B}/drive`); // Kim looks away
  await page.getByLabel('Message', { exact: true }).fill('Or 2?');
  await page.getByLabel('Message', { exact: true }).press('Enter');
  await page.getByText('Or 2?').waitFor();
  await page.waitForTimeout(800);
  if (await page.locator('.seen-mark').count()) throw new Error('still Seen');
  await kim.goto(`${B}/chat/${dm}`);
  await page.locator('.seen-mark').waitFor();
  if (await page.locator('.seen-mark').count() !== 1) throw new Error('more than one');
});
await step('turning read receipts off in Settings stops it both ways', async () => {
  await kim.goto(`${B}/settings`);
  await kim.getByLabel('Show “Seen” in direct messages').uncheck();
  await kim.getByText('Read receipts are off, both ways').waitFor();
  await page.reload();
  await page.getByText('Or 2?').waitFor();
  await page.waitForTimeout(800);
  if (await page.locator('.seen-mark').count()) throw new Error('still shown');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
