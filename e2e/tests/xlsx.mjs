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
const ExcelJS = (await import(`${ROOT}/server/node_modules/exceljs/excel.js`)).default;
const sheetOf = async (dl) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(fs.readFileSync(await dl.path())); return wb.worksheets[0]; };
let form, list;
await step('setup: a form with a response and a task list', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  form = (await api(page, 'POST', '/forms', { title: 'Lunch' })).body;
  form = (await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'food', type: 'short', title: 'Food' }] })).body;
  await page.evaluate(async (t) => fetch(`/api/public/forms/${t}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ answers: { food: 'Pizza' } }) }), form.token);
  list = (await api(page, 'POST', '/tasks/lists', { name: 'Launch' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book venue', due: '2026-12-01' });
});
await step('Form responses as Excel', async () => {
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByRole('tab', { name: 'Responses' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download Excel' }).click()]);
  if (dl.suggestedFilename() !== 'Lunch responses.xlsx') throw new Error(dl.suggestedFilename());
  const ws = await sheetOf(dl);
  const head = ws.getRow(1).values.filter(Boolean);
  const row = ws.getRow(2).values.filter(Boolean);
  if (!head.includes('Food') || !row.includes('Pizza')) throw new Error(JSON.stringify({ head, row }));
});
await step('A task list as Excel', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.getByText('Book venue').waitFor();
  await page.getByRole('button', { name: 'List actions' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Excel (.xlsx)' }).click()]);
  if (dl.suggestedFilename() !== 'Launch.xlsx') throw new Error(dl.suggestedFilename());
  const ws = await sheetOf(dl);
  if (ws.getCell('A2').value !== 'Book venue' || !(ws.getCell('C2').value instanceof Date)) throw new Error(JSON.stringify(ws.getRow(2).values));
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
