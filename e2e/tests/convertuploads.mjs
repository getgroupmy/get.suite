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
const { Document, Packer, Paragraph, HeadingLevel } = await import(`${ROOT}/server/node_modules/docx/dist/index.mjs`);
const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ text: 'Supplier contract', heading: HeadingLevel.HEADING_1 }), new Paragraph('Payment within 30 days.')] }] }));
const pick = (name) => ({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
await step('without the setting, a .docx uploads as a file', async () => {
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(pick('Old contract.docx'));
  await page.getByText('Old contract.docx').first().waitFor();
});
await step('Settings: Convert uploads; a .docx uploaded in Drive becomes a document, the file goes to the trash', async () => {
  await page.goto(`${B}/settings`);
  await page.getByLabel(/Convert uploads/).check();
  await page.getByText('Office files you upload will become documents').waitFor();
  await page.goto(`${B}/drive`);
  await page.locator('input[type="file"]:not([webkitdirectory])').first().setInputFiles(pick('Supplier contract.docx'));
  await page.getByText(/1 file converted to a document/).waitFor();
  await page.screenshot({ path: `${SP}/shots/convert-uploads.png` });
  const list = (await api(page, 'GET', '/files?view=mine')).body.map((f) => `${f.kind}:${f.name}`);
  if (!list.includes('doc:Supplier contract') || list.includes('file:Supplier contract.docx')) throw new Error(list.join(', '));
  if (!(await api(page, 'GET', '/files?view=trash')).body.some((f) => f.name === 'Supplier contract.docx')) throw new Error('not in the trash');
  await page.getByText('Supplier contract', { exact: true }).first().dblclick();
  await page.waitForURL(/\/docs\//);
  await page.locator('.ProseMirror h1', { hasText: 'Supplier contract' }).waitFor();
  await page.locator('.ProseMirror', { hasText: 'Payment within 30 days.' }).waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
