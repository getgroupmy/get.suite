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
const names = () => page.locator('.files tbody tr .name').allInnerTexts().then((l) => l.map((s) => s.trim().split('\n')[0]).sort());
await step('setup: files of several kinds, one old, one from a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Project notes' });
  await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Project budget' });
  await api(page, 'POST', '/files/folder', { name: 'Project archive' });
  await page.evaluate(async () => fetch('/api/files/upload?name=Project%20brief.pdf', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/pdf' }, body: '%PDF-1.4' }));
  const me = (await api(page, 'GET', '/auth/me')).body.user.id;
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const k = (await api(kim, 'POST', '/files/new', { kind: 'doc', name: 'Project timeline' })).body;
  await api(kim, 'PUT', `/files/${k.id}/shares`, { shares: [{ user_id: me, role: 'viewer' }] });
});
await step('search, then narrow by type', async () => {
  await page.getByLabel('Search everything').fill('project');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Search results for “project”' }).waitFor();
  await until(async () => (await names()).length === 5);
  await page.getByLabel('Type').selectOption({ label: 'Documents' });
  await until(async () => (await names()).join('|') === 'Project notes|Project timeline');
  if (!page.url().includes('type=doc')) throw new Error(page.url());
  await page.screenshot({ path: `${SP}/shots/search-filters.png` });
});
await step('by owner, combined with type', async () => {
  await page.getByLabel('Owner').selectOption({ label: 'Not owned by me' });
  await until(async () => (await names()).join('|') === 'Project timeline');
  await page.getByLabel('Owner').selectOption({ label: 'Owned by me' });
  await until(async () => (await names()).join('|') === 'Project notes');
});
await step('the filters survive going back; Clear filters shows everything again', async () => {
  await page.goto(`${B}/drive`);
  await page.goBack();
  await until(async () => (await names().catch(() => [])).join('|') === 'Project notes'); // still navigating: try again
  if ((await page.getByLabel('Type').inputValue()) !== 'doc') throw new Error('type lost');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await until(async () => (await names()).length === 5);
});
await step('no words needed: every PDF', async () => {
  // The pointer is still where the last step clicked, which the tips list would cover when it opens:
  // hovering picks a tip (and Enter would open it). Move it away first, then press Enter until the Search page shows.
  await page.mouse.move(5, 600);
  await page.getByLabel('Search everything').fill('');
  await until(async () => {
    if (await page.getByRole('heading', { name: 'Search', exact: true }).count()) return true;
    await page.getByLabel('Search everything').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    return false;
  }, 20000);
  await page.getByLabel('Type').selectOption({ label: 'PDFs' });
  await until(async () => (await names()).join('|') === 'Project brief.pdf');
  await page.getByLabel('Type').selectOption({ label: 'Folders' });
  await until(async () => (await names()).join('|') === 'Project archive');
  await page.getByLabel('Modified').selectOption({ label: 'Today' });
  await until(async () => (await names()).join('|') === 'Project archive');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
