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
let id;
const stage = () => page.locator('.slide-stage .slide').first();
await step('Theme and logo: own colours, font, a logo and footer on every slide but the first', async () => {
  const content = { theme: 'light', slides: [{ id: 's1', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Welcome' }] }, { id: 's2', items: [{ id: 'u', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Plans' }] }] };
  id = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Branded', content })).body.id;
  await page.goto(`${B}/slides/${id}`);
  await stage().getByText('Welcome').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Theme and logo/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Theme and logo' });
  await dlg.getByLabel('Background').fill('#102030');
  await dlg.getByLabel('Text', { exact: true }).fill('#fafafa');
  await dlg.getByLabel('Font').selectOption('Georgia');
  await dlg.locator('input[type=file]').setInputFiles(`${ROOT}/e2e/fixtures/logo.png`);
  await dlg.getByRole('button', { name: 'Remove logo' }).waitFor();
  await dlg.getByLabel('Logo corner').selectOption('br');
  await dlg.getByLabel('Footer').fill('Acme Trading · Confidential');
  await dlg.getByLabel('Preview').getByText('Acme Trading · Confidential').waitFor();
  await dlg.getByLabel('Preview').locator('img.slide-logo.br').waitFor();
  await dlg.getByLabel('Not on the first slide').check();
  await dlg.getByLabel('Preview').locator('.slide-footer').waitFor({ state: 'detached' }); // the preview is of the first slide
  await page.screenshot({ path: `${SP}/shots/theme-dialog.png` });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached' });
  const bg = await stage().evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).fontFamily]);
  if (bg[0] !== 'rgb(16, 32, 48)' || !/Georgia/.test(bg[1])) throw new Error(bg.join(' | '));
  if (await stage().locator('.slide-footer').count()) throw new Error('footer on the first slide');
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await stage().getByText('Plans').waitFor();
  await stage().getByText('Acme Trading · Confidential').waitFor();
  await until(() => stage().locator('img.slide-logo.br').evaluate((im) => im.complete && im.naturalWidth === 120));
  await page.screenshot({ path: `${SP}/shots/theme-slide.png` });
});
await step('it is kept, and the logo shows after a reload', async () => {
  await page.waitForTimeout(1200);
  await page.reload();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await stage().getByText('Acme Trading · Confidential').waitFor();
  await until(() => stage().locator('img.slide-logo').evaluate((im) => im.complete && im.naturalWidth === 120));
});
await step('the PowerPoint download has the colours, logo and footer', async () => {
  const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as PowerPoint (.pptx)' }).click()]);
  await dl.saveAs(`${SP}/theme-dl.pptx`);
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(`${SP}/theme-dl.pptx`));
  const two = await zip.file('ppt/slides/slide2.xml').async('string');
  if (!/102030/.test(two) || !/Acme Trading · Confidential/.test(two) || !/<p:pic>/.test(two) || !/Georgia/.test(two)) throw new Error(two.slice(0, 500));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
