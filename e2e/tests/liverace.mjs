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
// A list that's loading while something arrives live mustn't drop it when it lands (its answer is older).
let kim, gen, kimId;
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
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  gen = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  await api(page, 'POST', `/chat/channels/${gen}/messages`, { body: 'Earlier message' });
});
/** Answers to requests matching `re` are fetched from the server at once but handed to the page only on release(). */
async function hold(p, re) {
  const held = []; let open = false;
  await p.route(re, async (route) => {
    if (open || route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    held.push(() => route.fulfill({ response }));
  });
  return { count: () => held.length, release: async () => { open = true; for (const f of held) await f(); await p.unroute(re); } };
}
await step('Chat: a message sent while the conversation is loading shows once it has loaded', async () => {
  const h = await hold(kim, new RegExp(`/api/chat/channels/${gen}/messages(\\?|$)`));
  await kim.goto(`${B}/chat/${gen}`);
  await until(() => h.count() >= 1, 15000);
  await kim.waitForTimeout(1500); // the live connection is up
  await api(page, 'POST', `/chat/channels/${gen}/messages`, { body: 'Sent while you were loading' });
  await kim.waitForTimeout(1500); // it has arrived live
  await h.release();
  await kim.locator('.msg', { hasText: 'Earlier message' }).waitFor();
  await kim.locator('.msg', { hasText: 'Sent while you were loading' }).waitFor({ timeout: 5000 });
}, kim);
await step('Chat threads: a reply sent while the thread is loading shows once it has loaded', async () => {
  const parent = (await api(page, 'POST', `/chat/channels/${gen}/messages`, { body: 'Thread starter' })).body;
  const h = await hold(kim, new RegExp(`/api/chat/messages/${parent.id}/replies`));
  await kim.goto(`${B}/chat/${gen}?msg=${parent.id}&thread=${parent.id}`);
  await until(() => h.count() >= 1, 15000);
  await kim.waitForTimeout(1500);
  await api(page, 'POST', `/chat/channels/${gen}/messages`, { body: 'A reply while loading', parent_id: parent.id });
  await kim.waitForTimeout(1500);
  await h.release();
  await kim.getByText('A reply while loading').waitFor({ timeout: 5000 });
}, kim);
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
