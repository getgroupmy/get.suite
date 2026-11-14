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
await step('no templates yet: Import templates… reads a templates.json; Export gives one back', async () => {
  await until(async () => (await api(page, 'GET', '/mail/folders')).status === 200, 60000);
  await page.goto(`${B}/mail`);
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('menuitem', { name: 'Import templates…' }).click();
  const d = page.getByRole('dialog', { name: 'Templates' });
  await d.getByText('No templates yet.').waitFor();
  if (await d.getByRole('button', { name: 'Export' }).isEnabled()) throw new Error('export with nothing');
  const file = [{ name: 'Thanks', subject: 'Thank you', html: '<p>Thanks for your order.</p>' }, { name: 'Late', subject: 'Running late', html: '<p>Ten minutes late.</p>' }];
  await d.getByLabel('Import templates').setInputFiles({ name: 'templates.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await page.getByText('Added 2 templates').waitFor();
  await d.getByText('Thanks', { exact: true }).waitFor();
  await d.getByLabel('Import templates').setInputFiles({ name: 'templates.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await page.getByText('Those templates are all here already').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), d.getByRole('button', { name: 'Export' }).click()]);
  if (dl.suggestedFilename() !== 'templates.json') throw new Error(dl.suggestedFilename());
  const out = JSON.parse((await import('node:fs')).readFileSync(await dl.path(), 'utf8'));
  if (out.length !== 2 || !out.some((t) => t.name === 'Late' && t.html.includes('Ten minutes'))) throw new Error(JSON.stringify(out));
  await d.getByRole('button', { name: 'Close', exact: true }).last().click();
  // Using one fills in the message.
  await page.getByRole('button', { name: 'Templates' }).click();
  await page.getByRole('menuitem', { name: 'Late', exact: true }).click();
  await page.getByText('Ten minutes late.').first().waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
