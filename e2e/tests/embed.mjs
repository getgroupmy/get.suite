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
let form, v;
const qs = async () => (await api(page, 'GET', `/forms/${form.id}`)).body.questions;
await step('embed code for a published page and a form; both show inside another website, Workspace itself does not', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Opening hours' })).body;
  const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body;
  await api(page, 'PUT', `/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open 9 to 5, Monday to Friday' }] }] } });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Publish to the web…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish to the web' });
  await dlg.getByRole('button', { name: 'Publish' }).click();
  await dlg.getByText('Embed in a website').click();
  const pubCode = await dlg.getByLabel('Embed code').inputValue();
  if (!/^<iframe src="http:\/\/localhost:8090\/pub\/[\w-]+\?embed=1"/.test(pubCode)) throw new Error(pubCode);
  const form = (await api(page, 'POST', '/forms', { title: 'Contact us' })).body;
  await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'msg', type: 'paragraph', title: 'Your message' }] });
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Embed in a website' }).click();
  const formCode = await page.getByRole('dialog', { name: 'Embed in a website' }).getByLabel('Embed code').inputValue();
  // Someone's own website, on another origin, with both pasted in (and, wrongly, Drive too).
  const ctx = await browser.newContext(); const site = await ctx.newPage();
  site.on('pageerror', (e) => errors.push(`site: ${e.message}`));
  const http = await import('node:http');
  const other = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<h1>Acme</h1>${pubCode}${formCode}<iframe id="drive" src="${B}/drive"></iframe>`); });
  await new Promise((ok) => other.listen(9911, '127.0.0.1', ok));
  await site.goto('http://127.0.0.1:9911/');
  const pubFrame = site.frameLocator('iframe[src*="/pub/"]');
  await pubFrame.getByText('Open 9 to 5, Monday to Friday').waitFor();
  if (await pubFrame.locator('.pub-head:visible').count()) throw new Error('heading shown when embedded');
  const formFrame = site.frameLocator('iframe[src*="/f/"]');
  await formFrame.getByLabel('Your message').fill('Do you deliver?');
  await formFrame.getByRole('button', { name: 'Submit' }).click();
  await formFrame.getByText(/Your response has been recorded/).waitFor();
  const r = (await api(page, 'GET', `/forms/${form.id}/responses`)).body.responses;
  if (r[0]?.answers.msg !== 'Do you deliver?') throw new Error(JSON.stringify(r));
  await site.waitForTimeout(1000);
  const drive = site.frames().find((f) => f.url().includes('/drive'));
  if (drive && await drive.locator('text=Drive').count().catch(() => 0)) throw new Error('Drive shown inside another site');
  other.close();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
