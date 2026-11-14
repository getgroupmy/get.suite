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
let deck;
await step('a presentation downloads as OpenDocument (.odp)', async () => {
  deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Launch deck', content: { theme: 'ocean', slides: [
    { id: 's1', notes: 'Open with the numbers', items: [{ id: 't1', type: 'text', x: 10, y: 15, w: 80, h: 20, text: 'Launch plan', size: 60, bold: true, align: 'center' }, { id: 'sh', type: 'shape', shape: 'star', x: 70, y: 55, w: 15, h: 25, fill: '#ffd666', text: 'New' }] },
    { id: 's2', items: [{ id: 't2', type: 'text', x: 10, y: 10, w: 80, h: 15, text: 'Timeline', size: 40 }] },
  ] } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByText('Launch plan').first().waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as OpenDocument (.odp)' }).click()]);
  if (dl.suggestedFilename() !== 'Launch deck.odp') throw new Error(dl.suggestedFilename());
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(await dl.path());
  if (bytes.subarray(30, 85).toString() !== 'mimetypeapplication/vnd.oasis.opendocument.presentation') throw new Error('not an .odp');
  await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await fetch('/api/files/upload?name=Launch%20deck%20(Impress).odp', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bin }); }, bytes.toString('base64'));
});
await step('in Drive an .odp file shows as a presentation and opens as one, notes and all', async () => {
  await page.goto(`${B}/drive`);
  await page.getByText('Launch deck (Impress).odp').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Launch deck (Impress).odp' });
  await pv.getByText('Launch plan').first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SP}/shots/odp-preview.png` });
  await pv.getByRole('button', { name: 'Open as presentation' }).click();
  await page.waitForURL(/\/slides\//);
  await page.getByText('Launch plan').first().waitFor();
  await page.getByText('New', { exact: true }).first().waitFor();
  const id = new URL(page.url()).pathname.split('/').pop();
  const c = (await api(page, 'GET', `/files/${id}/content`)).body.content;
  if (c.slides.length !== 2 || c.slides[0].notes !== 'Open with the numbers' || c.slides[1].items[0].text !== 'Timeline') throw new Error(JSON.stringify(c).slice(0, 300));
  await page.screenshot({ path: `${SP}/shots/odp-opened.png` });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
