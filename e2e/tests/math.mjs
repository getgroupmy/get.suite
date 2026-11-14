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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
let doc;
const eq = (p, latex) => p.locator('.ProseMirror').getByRole('button', { name: `Equation: ${latex}`, exact: true }).and(p.locator(':has(.katex)'));
await step('∑ Equation writes LaTeX with a live preview and puts the equation in, drawn', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Physics notes' })).body;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Half is ');
  await page.getByRole('button', { name: 'Insert equation' }).click();
  const dlg = page.getByRole('dialog', { name: 'New equation' });
  await dlg.getByLabel('LaTeX').fill('\\frac{');
  await dlg.getByRole('alert').waitFor();
  if (await dlg.getByRole('button', { name: 'Insert' }).isEnabled()) throw new Error('broken LaTeX can be inserted');
  await dlg.getByLabel('LaTeX').fill('\\frac{1}{2}');
  await dlg.getByRole('img', { name: 'Preview' }).locator('.katex').waitFor();
  await dlg.getByRole('button', { name: 'Insert' }).click();
  await eq(page, '\\frac{1}{2}').waitFor();
  await page.keyboard.type(' and a square is $$x^2$$');
  await eq(page, 'x^2').waitFor();
});
await step('clicking an equation changes it; a colleague sees it live', async () => {
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await eq(kim, 'x^2').waitFor();
  await eq(page, 'x^2').click();
  const dlg = page.getByRole('dialog', { name: 'Change equation' });
  if ((await dlg.getByLabel('LaTeX').inputValue()) !== 'x^2') throw new Error('existing LaTeX');
  await dlg.getByLabel('LaTeX').fill('x^{2} + y^{2}');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await eq(page, 'x^{2} + y^{2}').waitFor();
  await eq(kim, 'x^{2} + y^{2}').waitFor();
  await page.keyboard.type('.');
  await page.locator('.ProseMirror', { hasText: /y2\s*\.$/ }).waitFor();
});
await step('Ω puts in special characters, found by name', async () => {
  await page.keyboard.type(' Cost ');
  await page.getByRole('button', { name: 'Insert special character' }).click();
  const dlg = page.getByRole('dialog', { name: 'Special characters' });
  await dlg.getByLabel('Search characters').fill('euro');
  await dlg.getByLabel('Search characters').press('Enter');
  await dlg.getByLabel('Search characters').fill('');
  await dlg.getByRole('button', { name: 'em dash' }).click();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.locator('.ProseMirror', { hasText: 'Cost €—' }).waitFor();
});
await step('equations come out as $…$ in Markdown', async () => {
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Markdown (.md)' }).click()]);
  const text = (await import('node:fs')).readFileSync(await dl.path(), 'utf8');
  if (!text.includes('Half is $\\frac{1}{2}$ and a square is $x^{2} + y^{2}$. Cost €—')) throw new Error(JSON.stringify(text));
  await page.screenshot({ path: `${SP}/shots/math.png` });
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
