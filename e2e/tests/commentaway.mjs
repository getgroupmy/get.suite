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
await step('a comment @mentioning someone whose working day is over says so under the box', async () => {
  const r = await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const today = new Date().getUTCDay();
  await api(kim, 'PUT', '/users/me/work-hours', { hours: { days: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today), start: 0, end: 1440, tz: 'UTC' } });
  const docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Budget for next year' }] }] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: r.body.id, role: 'editor' }] });
  await page.goto(`${B}/docs/${docId}`);
  await page.getByText('Budget for next year').waitFor();
  await page.locator('.paper .tiptap').click();
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('button', { name: 'Add comment' }).click();
  const box = page.getByLabel('New comment');
  await box.fill('@kim@acme.com can you check this?');
  const hint = page.getByRole('status', { name: 'Mentioned people who are away' });
  await hint.getByText('Kim Park').waitFor({ timeout: 10000 });
  await hint.getByText(/outside their working hours/).waitFor();
  await page.screenshot({ path: `${SP}/shots/comment-mention-away.png` });
  await box.fill('just a note');
  await hint.waitFor({ state: 'detached', timeout: 10000 });
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
