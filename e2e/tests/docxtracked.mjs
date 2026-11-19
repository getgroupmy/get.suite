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
await step('tracked changes in a Word file open as suggestions to accept', async () => {
  const b64 = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/office/tracked.docx`).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Plan.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  await page.goto(`${B}/docs/${opened.body.id}`);
  const ed = page.locator('.ProseMirror');
  await ed.locator('del.sugg-del', { hasText: 'March' }).waitFor();
  await ed.locator('ins.sugg-ins', { hasText: 'April' }).waitFor();
  if ((await ed.locator('ins.sugg-ins').getAttribute('title')) !== 'Suggested by Kim Park') throw new Error(await ed.locator('ins.sugg-ins').getAttribute('title'));
  await page.getByRole('button', { name: /suggestions/ }).click();
  const panel = page.getByRole('complementary', { name: 'Suggestions' });
  await panel.getByText('Kim Park').first().waitFor();
  await panel.getByText('Replace “March” with “April”').waitFor();
  const n = await panel.locator('button', { hasText: /^✓ Accept$/ }).count(); if (n !== 1) throw new Error('one suggestion: ' + n);
  await page.screenshot({ path: `${SP}/shots/docx-tracked.png` });
  await panel.getByRole('button', { name: 'Accept all' }).click();
  await until(async () => (await ed.innerText()).includes('The meeting is in April.') && !(await ed.locator('ins, del').count()));
});
await step('suggestions go out in an OpenDocument (.odt) download as tracked changes, LibreOffice keeps them, and they come back', async () => {
  const at = Date.parse('2026-11-03T09:30:00Z');
  const sg = (type) => ({ type, attrs: { id: 's1', by: null, name: 'Kim Park', at } });
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Agenda', content: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'We meet on ' }, { type: 'text', text: 'Monday', marks: [sg('suggestDelete')] }, { type: 'text', text: 'Tuesday', marks: [sg('suggestInsert')] }, { type: 'text', text: ' at noon.' }] },
  ] } })).body;
  await page.goto(`${B}/docs/${d.id}`);
  await page.locator('.ProseMirror ins.sugg-ins', { hasText: 'Tuesday' }).waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download as OpenDocument (.odt)' }).click()]);
  const fs = await import('node:fs'); const path = await import('node:path'); const { execFileSync } = await import('node:child_process');
  let bytes = fs.readFileSync(await dl.path());
  let lo = true;
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { lo = false; console.log('(LibreOffice is not installed here: the file is opened as downloaded)'); }
  if (lo) { // opened and saved again by LibreOffice
    const dir = fs.mkdtempSync(path.join(SP, 'lo-'));
    fs.writeFileSync(path.join(dir, 'Agenda.odt'), bytes);
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'odt', '--outdir', path.join(dir, 'out'), path.join(dir, 'Agenda.odt')], { stdio: 'ignore', timeout: 120000 });
    bytes = fs.readFileSync(path.join(dir, 'out', 'Agenda.odt'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await fetch('/api/files/upload?name=Agenda%20(Writer).odt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bin }); }, bytes.toString('base64'));
  await page.goto(`${B}/drive`);
  await page.getByText('Agenda (Writer).odt').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Agenda (Writer).odt' });
  await pv.getByRole('button', { name: 'Open as document' }).click({ timeout: 20000 });
  await page.waitForURL(/\/docs\//);
  const ed = page.locator('.ProseMirror');
  await ed.locator('del.sugg-del', { hasText: 'Monday' }).waitFor();
  await ed.locator('ins.sugg-ins', { hasText: 'Tuesday' }).waitFor();
  if ((await ed.locator('ins.sugg-ins').getAttribute('title')) !== 'Suggested by Kim Park') throw new Error(await ed.locator('ins.sugg-ins').getAttribute('title'));
  await page.getByRole('button', { name: /suggestions/ }).click();
  const panel = page.getByRole('complementary', { name: 'Suggestions' });
  await panel.getByText('Replace “Monday” with “Tuesday”').waitFor();
  await page.screenshot({ path: `${SP}/shots/odt-tracked.png` });
  await panel.getByRole('button', { name: 'Accept all' }).click();
  await until(async () => (await ed.innerText()).includes('We meet on Tuesday at noon.') && !(await ed.locator('ins, del').count()));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
