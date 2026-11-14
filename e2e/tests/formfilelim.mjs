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
await step('the owner limits a file question to PDFs and pictures, up to 1 MB, in the editor', async () => {
  form = (await api(page, 'POST', '/forms', { title: 'Expense claim' })).body;
  form = (await api(page, 'PUT', `/forms/${form.id}`, { audience: 'public', questions: [{ id: 'rc', type: 'file', title: 'Receipt', required: true, max_files: 2 }] })).body;
  await page.goto(`${B}/forms/${form.id}`);
  const kinds = page.getByRole('group', { name: 'Kinds of file for question 1' });
  await kinds.getByLabel('PDFs').check();
  await kinds.getByLabel('Pictures').check();
  await page.getByLabel('Largest file for question 1').selectOption('1');
  await page.screenshot({ path: `${SP}/shots/form-file-limits.png` });
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };
  await until(async () => { const q = (await api(page, 'GET', `/forms/${form.id}`)).body.questions[0]; return q.max_mb === 1 && JSON.stringify(q.accept) === '["pdf","pictures"]'; });
});
await step('a visitor: the picker is limited; a wrong kind, a big file and a renamed one are refused; a PDF goes', async () => {
  const ctx = await browser.newContext(); visitor = await ctx.newPage();
  visitor.on('pageerror', (e) => errors.push(`visitor: ${e.message}`));
  await visitor.goto(`${B}/f/${form.token}`);
  await visitor.getByText('PDFs or pictures: up to 2 files, 1 MB each').waitFor();
  const input = () => visitor.getByLabel('Add a file: Receipt (required)');
  if (!(await input().getAttribute('accept')).startsWith('.pdf,.jpg')) throw new Error('picker');
  const alert = visitor.getByRole('alert');
  await input().setInputFiles({ name: 'notes.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\x03\x04') });
  await alert.getByText("notes.docx can't be sent here: this question only takes PDFs or pictures").waitFor();
  await input().setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1100 * 1024, 1) });
  await alert.getByText('scan.pdf is too large: files can be up to 1 MB').waitFor();
  await input().setInputFiles({ name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ a program') });
  await alert.getByText("receipt.pdf doesn't look like the kind of file its name says, so it wasn't sent").waitFor();
  await input().setInputFiles({ name: 'taxi.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 taxi') });
  await visitor.getByRole('list', { name: "Files you've added" }).getByText('taxi.pdf').waitFor();
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await visitor.getByText(/Your response has been recorded/).waitFor();
  await ctx.close();
});
await step('only the PDF arrived', async () => {
  const rs = (await api(page, 'GET', `/forms/${form.id}/responses`)).body;
  const names = (rs.responses || rs)[0].answers.rc.map((x) => x.name);
  if (JSON.stringify(names) !== '["taxi.pdf"]') throw new Error(JSON.stringify(names));
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
