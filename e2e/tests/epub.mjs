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
const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
const fs = await import('node:fs');
await step('Download as e-book (.epub): chapters from the headings, readable', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Staff handbook' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+Alt+1'); await page.keyboard.type('Welcome'); await page.keyboard.press('Enter');
  await page.keyboard.type('Glad you are here.'); await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Alt+1'); await page.keyboard.type('Holidays'); await page.keyboard.press('Enter');
  await page.keyboard.type('25 days a year.');
  await page.getByText('All changes saved').waitFor();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as e-book (.epub)' }).click()]);
  if (dl.suggestedFilename() !== 'Staff handbook.epub') throw new Error(dl.suggestedFilename());
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  const nav = await zip.file('OEBPS/nav.xhtml').async('string');
  if (!/>Welcome<[\s\S]*>Holidays</.test(nav)) throw new Error(nav);
  const ch2 = await zip.file('OEBPS/chapter2.xhtml').async('string');
  if (!/<h1>Holidays<\/h1>\s*<p>25 days a year\.<\/p>/.test(ch2)) throw new Error(ch2);
  // Opened in the browser as a reader would: the chapter shows.
  const view = await browser.newPage();
  await view.setContent(ch2.replace(/^<\?xml[^>]*>\s*<!DOCTYPE html>/, ''));
  await view.getByRole('heading', { name: 'Holidays' }).waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
