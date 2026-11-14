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
await step('setup: a folder with files and a sub-folder', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Project' })).body;
  const sub = (await api(page, 'POST', '/files/folder', { name: 'Assets', parent_id: folder.id })).body;
  await page.evaluate(async ([f, s]) => {
    const up = (name, n, parent) => fetch(`/api/files/upload?name=${name}&parent=${parent}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: new Uint8Array(n) });
    await up('plan.pdf', 2048, f); await up('video.mp4', 3 * 1024 * 1024, s); await up('logo.png', 20480, s);
  }, [folder.id, sub.id]);
  await page.goto(`${B}/drive`);
  await page.locator('.files tbody tr', { hasText: 'Project' }).first().waitFor();
});
await step('Details of a folder: its size, what it holds, the biggest files', async () => {
  await page.locator('.files tbody tr', { hasText: 'Project' }).first().getByRole('button', { name: 'Actions for Project' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const dlg = page.getByRole('dialog', { name: 'Details' });
  await dlg.getByText(/3\.0[0-9]? MB · 3 files, 1 folder/).waitFor();
  await dlg.getByText('Biggest files').click();
  const names = await dlg.locator('.folder-biggest li a').allInnerTexts();
  if (names.join() !== 'video.mp4,logo.png,plan.pdf') throw new Error(names.join());
  await page.screenshot({ path: `${SP}/shots/foldersize.png` });
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
