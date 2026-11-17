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
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const signIn = async (p, email) => {
  await p.goto(B);
  await p.getByLabel('Email address').fill(email);
  await p.getByLabel('Password').fill('password123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.getByRole('link', { name: 'Mail' }).click();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive' }).waitFor();
});
await step('starring a folder puts it in the sidebar; clicking it opens the folder', async () => {
  const f = (await api(page, 'POST', '/files/folder', { name: 'Board papers' })).body;
  await api(page, 'POST', '/files/folder', { name: 'Inside', parent_id: f.id });
  await api(page, 'POST', '/files/folder', { name: 'Unstarred' });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Board papers' }).click();
  await page.getByRole('menuitem', { name: 'Add star' }).click();
  const side = page.getByRole('group', { name: 'Starred folders' });
  await side.getByRole('link', { name: 'Board papers' }).waitFor();
  if (await side.getByRole('link', { name: 'Unstarred' }).count()) throw new Error('unstarred shown');
  await page.goto(`${B}/drive/recent`);
  await side.getByRole('link', { name: 'Board papers' }).click();
  await page.getByText('Inside', { exact: true }).waitFor();
  await page.waitForURL(new RegExp(`/drive/folder/${f.id}`));
  await page.screenshot({ path: `${SP}/shots/starred-folders.png` });
});
await step('removing the star takes it out of the sidebar', async () => {
  await page.goto(`${B}/drive/starred`);
  await page.getByRole('button', { name: 'Actions for Board papers' }).click();
  await page.getByRole('menuitem', { name: 'Remove star' }).click();
  await until(async () => (await page.getByRole('group', { name: 'Starred folders' }).count()) === 0);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
