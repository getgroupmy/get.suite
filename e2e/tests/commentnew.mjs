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
const btn = (p) => p.locator('.editor-head, header, body').getByRole('button', { name: /Comments/ }).first();
await step('comments from others since you last looked: “1 new” on the button and New on the thread; looking clears it', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'New plan' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'First thought', anchor: { quote: 'a' }, id: 'thread-new-1' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await btn(kim).getByText('1 new').waitFor();
  await btn(kim).click();
  const kp = kim.getByRole('complementary', { name: 'Comments' });
  const thread = kp.locator('.comment-thread', { hasText: 'First thought' });
  await thread.getByText('New', { exact: true }).waitFor();
  await kim.screenshot({ path: `${SP}/shots/comment-new.png` });
  await until(async () => (await btn(kim).getByText(/\d+ new/).count()) === 0);
  // Closed and opened again: nothing new any more.
  await kp.getByRole('button', { name: 'Close comments' }).click();
  await btn(kim).click();
  await kp.getByText('First thought').waitFor();
  if (await thread.getByText('New', { exact: true }).count()) throw new Error('still new');
  await kp.getByRole('button', { name: 'Close comments' }).click();
});
await step('a reply while the panel is closed shows as new, live; Kim’s own comment never does', async () => {
  await api(page, 'POST', `/comments/${doc.id}`, { body: 'And another thing', thread_id: 'thread-new-1' });
  await btn(kim).getByText('1 new').waitFor({ timeout: 10000 });
  await api(kim, 'POST', `/comments/${doc.id}`, { body: 'Kim’s own', anchor: { quote: 'k' } });
  await kim.waitForTimeout(800);
  if (!(await btn(kim).getByText('1 new').count())) throw new Error('her own counted');
  await kim.reload();
  await btn(kim).getByText('1 new').waitFor();
  await btn(kim).click();
  await kim.getByRole('complementary', { name: 'Comments' }).locator('.comment-thread.new', { hasText: 'And another thing' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
