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
const upload = (name, text, parent) => page.evaluate(async ([n, t, p]) => (await (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}${p ? `&parent=${p}` : ''}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: t })).json()), [name, text, parent]);
let ids = {};
await step('Storage finds files with the same content', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Backups' })).body;
  ids.a = (await upload('budget.xlsx', 'SAME-BYTES-'.repeat(500))).id;
  ids.b = (await upload('budget (copy).xlsx', 'SAME-BYTES-'.repeat(500), folder.id)).id;
  ids.c = (await upload('photo.jpg', 'PHOTO'.repeat(200))).id;
  ids.d = (await upload('photo-2.jpg', 'PHOTO'.repeat(200))).id;
  ids.e = (await upload('unique.txt', 'only one')).id;
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Storage' }).click();
  const d = page.getByRole('dialog', { name: 'Storage' });
  await d.getByRole('button', { name: 'Find duplicate files' }).click();
  const sec = d.getByRole('region', { name: 'Duplicate files' });
  await sec.getByText('2 copies').first().waitFor();
  if (await sec.locator('.dup-group').count() !== 2) throw new Error('groups');
  await sec.getByText('budget (copy).xlsx').waitFor();
  await sec.getByText(/Backups ·/).waitFor();
  if (await sec.getByText('unique.txt').count()) throw new Error('unique listed');
});
await step('keep the newest, trash the rest', async () => {
  const sec = page.getByRole('region', { name: 'Duplicate files' });
  const group = sec.locator('.dup-group', { hasText: 'budget' });
  await group.getByRole('button', { name: 'Keep the newest, trash 1' }).click();
  await page.getByText('Moved 1 to trash').waitFor();
  await until(async () => (await sec.locator('.dup-group').count()) === 1);
  const a = (await api(page, 'GET', `/files/${ids.a}`)).body, b = (await api(page, 'GET', `/files/${ids.b}`)).body;
  if (a.trashed === b.trashed) throw new Error('one should be in the trash');
  if (b.trashed) throw new Error('the newest (b) should stay');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
