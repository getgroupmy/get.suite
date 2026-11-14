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
await step('a sent message says it was delivered, or why not', async () => {
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 90000);
  const subject = `Quote ${Date.now()}`;
  await until(async () => (await api(page, 'POST', '/mail/send', { to: 'postmaster@acme.com, nobody@[192.0.2.10]', subject, text: 'Here is the quote.' })).status === 200, 30000);
  const folders = (await api(page, 'GET', '/mail/folders')).body;
  const sentPath = folders.find((f) => f.specialUse === '\\Sent').path;
  const uid = await until(async () => ((await api(page, 'GET', `/mail/messages?folder=${encodeURIComponent(sentPath)}&q=${encodeURIComponent(subject)}`)).body.messages || [])[0]?.uid, 30000);
  // The stuck recipient takes Postfix's connection timeout to be logged as waiting.
  await until(async () => {
    await page.goto(`${B}/mail/${encodeURIComponent(sentPath)}/${uid}`);
    await page.getByText(subject).first().waitFor();
    const d = page.getByRole('group', { name: 'Delivery' });
    return (await d.count()) && (await d.getByText('Waiting to retry').count()) && (await d.getByText('Delivered', { exact: true }).count());
  }, 120000);
  const d = page.getByRole('group', { name: 'Delivery' });
  await d.getByText('1 not delivered yet').waitFor();
  await d.getByText(/reached olivia@acme\.com/).waitFor();
  await d.getByText(/keeps trying for up to 5 days/).waitFor();
  await page.screenshot({ path: `${SP}/shots/delivery.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
