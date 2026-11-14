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
const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
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
await step('a comment made in Docs goes into the Word download', async () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revenue grew by twelve percent this year.' }] }] };
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content })).body;
  await page.goto(`${B}/docs/${d.id}`);
  const word = page.locator('.ProseMirror').getByText('Revenue grew by twelve percent this year.');
  await word.waitFor();
  await word.dblclick({ position: { x: 150, y: 8 } }); // a word in the middle
  const picked = await page.evaluate(() => String(window.getSelection()));
  await page.keyboard.press('Control+Alt+m');
  const box = page.getByPlaceholder(/comment/i).first();
  await box.waitFor();
  await box.fill('Is this the final figure?');
  await page.getByRole('button', { name: 'Comment', exact: true }).last().click();
  await page.locator('.ProseMirror [data-comment]').waitFor();
  await page.waitForTimeout(1500); // saved
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as Word (.docx)' }).click()]);
  const file = `${SP}/report-dl.docx`;
  await dl.saveAs(file);
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(file));
  const xml = await zip.file('word/comments.xml')?.async('string');
  if (!xml || !/Is this the final figure\?/.test(xml) || !/w:author="Olivia Owner"/.test(xml)) throw new Error('comments: ' + (xml || 'none').slice(0, 300));
  const body = await zip.file('word/document.xml').async('string');
  if (!/<w:commentRangeStart w:id="0"\/>/.test(body)) throw new Error('no range');
  console.log('DBG commented', JSON.stringify(picked.trim()));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
