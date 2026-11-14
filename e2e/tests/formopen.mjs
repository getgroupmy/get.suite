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
let form;
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
  form = (await api(page, 'POST', '/forms', { title: 'Course sign-up', questions: [{ id: 'q', type: 'short', title: 'Your name' }] })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public' });
});
await step('set it to open tomorrow at 9:00 in Settings', async () => {
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  const d = new Date(); d.setDate(d.getDate() + 1);
  const pad = (n) => String(n).padStart(2, '0');
  await page.getByLabel('Open automatically on').fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`);
  await page.screenshot({ path: `${SP}/shots/formopen-settings.png` });
  await page.waitForTimeout(800);
  await page.getByRole('tab', { name: /Responses/ }).click();
  await page.getByText(/This form opens on .*Until then, people who open the link are told when it opens\./).waitFor();
  await page.goto(`${B}/forms`);
  await page.getByText('Opens later').waitFor();
});
await step('someone with the link is told when it opens', async () => {
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`${B}/f/${form.token}`);
  await anon.getByText(/This form opens on .*9:00.*Come back then\./).waitFor();
  if (await anon.getByRole('button', { name: 'Submit' }).count()) throw new Error('no submit before it opens');
  await anon.screenshot({ path: `${SP}/shots/formopen-anon.png` });
});
await step('a page left open opens the form when the time comes', async () => {
  await api(page, 'PUT', `/forms/${form.id}`, { open_at: Date.now() + 4000 });
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`${B}/f/${form.token}`);
  await anon.getByText(/This form opens on/).waitFor();
  await anon.getByRole('button', { name: 'Submit' }).waitFor({ timeout: 15000 });
  await anon.getByLabel('Your name').fill('Ana');
  await anon.getByRole('button', { name: 'Submit' }).click();
  await anon.getByText(/recorded/i).waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
