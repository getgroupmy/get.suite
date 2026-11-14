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
let kim, doc;
await step('Drive marks files with new comments for you; it goes once you’ve looked, and comes back live', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Marked doc' })).body;
  const quiet = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Quiet doc' })).body;
  for (const f of [doc, quiet]) await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'Look here', anchor: { quote: 'a' }, id: 'thread-dn-1' });
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'And here', anchor: { quote: 'b' }, id: 'thread-dn-2' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/drive/shared`);
  const row = (name) => kim.locator('.files tbody tr', { hasText: name });
  await row('Marked doc').getByLabel('2 new comments').waitFor();
  if (await row('Quiet doc').locator('.comment-mark').count()) throw new Error('quiet marked');
  await kim.screenshot({ path: `${SP}/shots/drive-new-comments.png` });
  // She opens its comments, then comes back.
  await kim.goto(`${B}/docs/${doc.id}?comment=thread-dn-1`);
  await kim.getByRole('complementary', { name: 'Comments' }).getByText('Look here').waitFor();
  await kim.waitForTimeout(600);
  await kim.goto(`${B}/drive/shared`);
  await row('Quiet doc').waitFor();
  await row('Marked doc').waitFor();
  await until(async () => (await row('Marked doc').locator('.comment-mark').count()) === 0);
  // Olivia replies while Kim is looking at Drive.
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'One more', thread_id: 'thread-dn-2' });
  await row('Marked doc').getByLabel('1 new comment').waitFor({ timeout: 10000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
