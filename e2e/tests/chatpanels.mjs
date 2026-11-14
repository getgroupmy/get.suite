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
let ch;
await step('a saved message', async () => {
  ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  const m = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'The supplier quote is RM 4,500' })).body;
  await api(page, 'PUT', `/chat/messages/${m.id}/saved`, { saved: true });
});
for (const [label, list] of [['Saved', 'Saved messages'], ['Unreads', null], ['Mentions', null], ['Threads', null]]) {
  await step(`${label} clicked before the conversations have loaded stays open`, async () => {
    // Hold back the list of conversations, so Chat picks the first one only after the click.
    await page.route('**/api/chat/channels', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue().catch(() => {}); });
    await page.goto(`${B}/chat`);
    await page.getByRole('button', { name: new RegExp(`^.?\\s*${label}`) }).first().click();
    await page.waitForTimeout(2500); // the list has come, and the first conversation is chosen behind the panel
    await page.unroute('**/api/chat/channels');
    await page.getByRole('heading', { name: label, exact: true }).waitFor({ timeout: 3000 });
    if (list) await page.getByRole('list', { name: list }).getByText('The supplier quote is RM 4,500').waitFor();
  });
}
await step('picking a conversation still closes the list', async () => {
  await page.goto(`${B}/chat`);
  await page.getByRole('button', { name: /Saved/ }).first().click();
  await page.getByRole('heading', { name: 'Saved', exact: true }).waitFor();
  await page.getByRole('button', { name: /^#\s*office/ }).first().click();
  await page.getByRole('heading', { name: 'Saved', exact: true }).waitFor({ state: 'detached' });
  await page.getByRole('heading', { name: '# office' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
