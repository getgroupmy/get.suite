import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import fs from "node:fs";
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
let ch;
await step('setup: a channel with a thread', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  ch = (await api(page, 'POST', '/chat/channels', { name: 'launch' })).body.id;
  const m = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Ship on Friday?' })).body;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Yes, Friday works', parent_id: m.id });
  await page.goto(`${B}/chat/${ch}`);
  await page.getByText('Ship on Friday?').waitFor();
});
const grab = async (label) => {
  await page.getByRole('button', { name: 'Download conversation' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: label }).click()]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
};
await step('Download as a web page and as text', async () => {
  const h = await grab('As a web page (.html)');
  if (h.name !== 'launch.html') throw new Error(h.name);
  if (!h.text.includes('<h1>#launch</h1>') || !h.text.includes('Ship on Friday?') || !/class="m r"[\s\S]*Yes, Friday works/.test(h.text)) throw new Error(h.text.slice(0, 400));
  const t = await grab('As plain text (.txt)');
  if (t.name !== 'launch.txt') throw new Error(t.name);
  if (!/Olivia Owner:\n  Ship on Friday\?\n    ↳ \[.*\] Olivia Owner:\n      Yes, Friday works/.test(t.text)) throw new Error(t.text);
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (!t.text.includes(`(${zone})`)) throw new Error(`zone ${zone} not used: ${t.text.split('\n')[1]}`);
});
await step('Download with its files (.zip): the page and the files shared in it', async () => {
  const up = await page.request.post(`${B}/api/files/upload?name=agenda.txt`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, data: 'Item one' });
  const f = await up.json();
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'The agenda', files: [f.id] });
  await page.getByText('The agenda').waitFor();
  await page.getByRole('button', { name: 'Download conversation' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'With its files (.zip)' }).click()]);
  if (dl.suggestedFilename() !== 'launch.zip') throw new Error(dl.suggestedFilename());
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
  if (await zip.file('Files/agenda.txt')?.async('string') !== 'Item one') throw new Error(Object.keys(zip.files).join());
  if (!/The agenda/.test(await zip.file('launch.html').async('string'))) throw new Error('page');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
