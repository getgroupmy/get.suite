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
let doc;
await step('a document downloads as OpenDocument (.odt)', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Board minutes' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Decisions');
  await page.keyboard.press('Enter');
  await page.keyboard.type('We agreed to ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('hire two people');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('.');
  await page.getByText('All changes saved').waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as OpenDocument (.odt)' }).click()]);
  if (dl.suggestedFilename() !== 'Board minutes.odt') throw new Error(dl.suggestedFilename());
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(await dl.path());
  if (bytes.subarray(30, 77).toString() !== 'mimetypeapplication/vnd.oasis.opendocument.text') throw new Error('not an .odt');
  // Into Drive as a file (as if it came back from LibreOffice).
  await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await fetch('/api/files/upload?name=Board%20minutes%20(edited).odt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bin }); }, bytes.toString('base64'));
});
await step('in Drive an .odt file shows as a document and opens as one', async () => {
  await page.goto(`${B}/drive`);
  await page.getByText('Board minutes (edited).odt').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Board minutes (edited).odt' });
  await pv.getByText('hire two people').waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SP}/shots/odt-preview.png` });
  await pv.getByRole('button', { name: 'Open as document' }).click();
  await page.waitForURL(/\/docs\//);
  await page.locator('.ProseMirror strong', { hasText: 'hire two people' }).waitFor();
  await page.locator('.ProseMirror', { hasText: 'Decisions' }).waitFor();
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
