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
const step = async (name, fn, p0 = page) => { const p = typeof p0 === 'function' ? p0() : p0;
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };

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
let launch, office, dev2;
const row = (p, name) => p.locator('.subnav').getByRole('button', { name: new RegExp(`^# ?${name}`) });
const boxOf = (p) => p.getByRole('textbox', { name: 'Message', exact: true });
await step('a draft stays with its conversation, marked ✏️ in the list', async () => {
  launch = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  office = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await page.goto(`${B}/chat/${launch}`);
  await boxOf(page).fill('Draft for the launch');
  await row(page, 'office').click();
  await until(async () => (await boxOf(page).inputValue()) === '');
  await row(page, 'launch').getByLabel('Draft').waitFor();
  await page.screenshot({ path: `${SP}/shots/chatdraft.png` });
  await row(page, 'launch').click();
  await until(async () => (await boxOf(page).inputValue()) === 'Draft for the launch');
  if (await row(page, 'launch').getByLabel('Draft').count()) throw new Error('marked while open');
});
await step('the other device has it too, and sees it change', async () => {
  dev2 = await mk('olivia-2'); await signIn(dev2, 'olivia@acme.com');
  await dev2.goto(`${B}/chat/${office}`);
  await row(dev2, 'launch').getByLabel('Draft').waitFor();
  await row(dev2, 'launch').click();
  await until(async () => (await boxOf(dev2).inputValue()) === 'Draft for the launch');
  await row(dev2, 'office').click();
  await boxOf(page).fill('Draft for the launch, longer');
  await until(async () => ((await api(dev2, 'GET', '/chat/drafts')).body[launch]?.body) === 'Draft for the launch, longer');
  await row(dev2, 'launch').click();
  await until(async () => (await boxOf(dev2).inputValue()) === 'Draft for the launch, longer');
}, () => dev2);
await step('sending clears it everywhere', async () => {
  await row(dev2, 'office').click();
  await boxOf(page).press('Enter');
  await page.locator('.messages').getByText('Draft for the launch, longer').waitFor();
  await until(async () => (await row(dev2, 'launch').getByLabel('Draft').count()) === 0);
  await until(async () => Object.keys((await api(page, 'GET', '/chat/drafts')).body).length === 0);
});
await step('a draft survives reloading the page', async () => {
  await row(page, 'office').click();
  await page.getByRole('heading', { name: /office/ }).waitFor();
  await boxOf(page).fill('Back after lunch');
  await new Promise((r) => setTimeout(r, 1200));
  await page.reload();
  await until(async () => (await boxOf(page).inputValue()) === 'Back after lunch');
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
