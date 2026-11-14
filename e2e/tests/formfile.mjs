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
let form, visitor;
await step('a public form with a file question', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Job application' })).body;
  form = (await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'nm', type: 'short', title: 'Your name', required: true }, { id: 'cv', type: 'file', title: 'Your CV', required: true, max_files: 2 }] })).body;
  await page.goto(`${B}/forms/${form.id}`);
  await page.getByLabel('Files for question 2').waitFor();
  if (await page.getByLabel('Files for question 2').inputValue() !== '2') throw new Error('max files');
});
await step('a visitor attaches two files and sends it', async () => {
  const ctx = await browser.newContext(); visitor = await ctx.newPage();
  visitor.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await visitor.goto(`${B}/f/${form.token}`);
  await visitor.getByLabel('Your name (required)').fill('Ann Applicant');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await visitor.getByText('This question needs an answer').waitFor();
  const input = visitor.getByLabel('Add a file: Your CV (required)');
  await input.setInputFiles([{ name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 cv') }, { name: 'letter.txt', mimeType: 'text/plain', buffer: Buffer.from('Dear team') }]);
  const files = visitor.getByRole('list', { name: "Files you've added" });
  await files.getByText('cv.pdf').waitFor();
  await files.getByText('letter.txt').waitFor();
  if (await visitor.getByLabel('Add a file: Your CV (required)').count()) throw new Error('full: no more');
  await visitor.getByRole('button', { name: 'Remove letter.txt' }).click();
  await visitor.getByLabel('Add a file: Your CV (required)').setInputFiles({ name: 'cover.txt', mimeType: 'text/plain', buffer: Buffer.from('Cover') });
  await files.getByText('cover.txt').waitFor();
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await visitor.getByText(/Your response has been recorded/).waitFor();
});
await step('the owner sees the files in Responses, and in Drive', async () => {
  await page.goto(`${B}/forms/${form.id}?tab=responses`);
  const sum = page.getByRole('region', { name: 'Summary: Your CV' });
  const link = sum.getByRole('link', { name: '📎 cv.pdf' });
  await link.waitFor();
  const href = await link.getAttribute('href');
  const r = await page.evaluate(async (u) => { const x = await fetch(u); return [x.status, await x.text()]; }, href);
  if (r[0] !== 200 || !r[1].includes('%PDF-1.4 cv')) throw new Error(JSON.stringify(r));
  await sum.getByRole('link', { name: '📎 cover.txt' }).waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('row', { name: /Job application \(File uploads\)/ }).dblclick();
  await page.getByRole('row', { name: /cv\.pdf/ }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
