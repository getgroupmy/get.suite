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
let doc, url;
const t = (text) => ({ type: 'text', text });
const filler = Array.from({ length: 40 }, (_, i) => ({ type: 'paragraph', content: [t(`Line ${i + 1} of the introduction.`)] }));
await step('the outline copies a link to a heading', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('Introduction')] }, ...filler,
    { type: 'heading', attrs: { level: 2 }, content: [t('Budget & costs')] }, { type: 'paragraph', content: [t('Money matters.')] }, ...filler,
  ] } })).body;
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').getByText('Money matters.').waitFor();
  await page.getByRole('button', { name: 'Outline' }).click();
  await page.getByRole('button', { name: 'Copy link to Budget & costs' }).click();
  await page.getByText('Link to “Budget & costs” copied').waitFor();
  url = await page.evaluate(() => navigator.clipboard.readText());
  if (url !== `${B}/docs/${doc.id}#budget-costs`) throw new Error(url);
});
await step('opening the link goes straight to that heading', async () => {
  const p2 = await mk('second');
  await signIn(p2, 'olivia@acme.com');
  await p2.goto(url);
  const h = p2.locator('.ProseMirror h2', { hasText: 'Budget & costs' });
  await h.waitFor();
  await until(async () => { const top = await h.evaluate((el) => el.getBoundingClientRect().top); return top >= 0 && top < 300; });
  await p2.screenshot({ path: `${SP}/shots/headinglink.png` });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
