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
let docId;
await step('a Word file\'s comments open as comment threads on their words', async () => {
  const b64 = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/office/review.docx`).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Review.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  docId = opened.body.id;
  await page.goto(`${B}/docs/${opened.body.id}`);
  const mark = page.locator('.ProseMirror [data-comment]');
  await mark.waitFor();
  if ((await mark.innerText()) !== '12 percent') throw new Error(await mark.innerText());
  await mark.click();
  await page.getByText('Can we check this figure?').first().waitFor();
  await page.getByText('— Jane Smith (in the Word file)').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/docx-comments.png` });
});
await step('the .odt download keeps the comment thread: reopened, it is on the same words, with who wrote it', async () => {
  const root = (await api(page, 'GET', `/comments/${docId}`)).body.find((c) => !c.thread_id);
  if ((await api(page, 'POST', `/comments/${docId}`, { body: 'Checked: it is 12.', thread_id: root.id })).status !== 201) throw new Error('reply');
  const up = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=odt`)).arrayBuffer();
    return (await fetch('/api/files/upload?name=Review.odt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
  }, docId);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  await page.goto(`${B}/docs/${opened.body.id}`);
  const mark = page.locator('.ProseMirror [data-comment]');
  await mark.waitFor();
  if ((await mark.innerText()) !== '12 percent') throw new Error(await mark.innerText());
  await mark.click();
  await page.getByText('Can we check this figure?').first().waitFor();
  await page.getByText(/— Olivia Owner \(in the OpenDocument file\)/).first().waitFor();
  await page.getByText('Checked: it is 12.').first().waitFor(); // the reply, as a reply
  const threads = (await api(page, 'GET', `/comments/${opened.body.id}`)).body;
  if (threads.filter((c) => !c.thread_id).length !== 1 || threads.filter((c) => c.thread_id).length !== 1) throw new Error(JSON.stringify(threads.map((c) => [c.thread_id, c.body])));
  await page.screenshot({ path: `${SP}/shots/odt-comments.png` });
});
await step('a Word download saved again by LibreOffice keeps the reply as a reply', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); } catch { console.log('(LibreOffice not installed: skipped)'); return; }
  const bytes = await page.evaluate(async (id) => Array.from(new Uint8Array(await (await fetch(`/api/files/${id}/export?format=docx`)).arrayBuffer())), docId);
  const dir = fs.mkdtempSync(`${SP}/lo-`);
  fs.writeFileSync(`${dir}/in.docx`, Buffer.from(bytes));
  fs.mkdirSync(`${dir}/out`);
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'docx', '--outdir', `${dir}/out`, `${dir}/in.docx`], { stdio: 'ignore', timeout: 120000 });
  const b64 = fs.readFileSync(`${dir}/out/in.docx`).toString('base64');
  const up = await page.evaluate(async (data) => (await fetch('/api/files/upload?name=Review-LO.docx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) })).json(), b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  const threads = (await api(page, 'GET', `/comments/${opened.body.id}`)).body;
  if (threads.filter((c) => !c.thread_id).length !== 1 || !threads.some((c) => c.thread_id && c.body.includes('Checked: it is 12.'))) throw new Error(JSON.stringify(threads.map((c) => [c.thread_id, c.body])));
  await page.goto(`${B}/docs/${opened.body.id}`);
  const mark = page.locator('.ProseMirror [data-comment]');
  await mark.waitFor();
  await mark.click();
  await page.getByText('Checked: it is 12.').first().waitFor();
});
await step('a comment resolved in LibreOffice comes in resolved (hidden until Show resolved)', async () => {
  const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
  const bytes = await page.evaluate(async (id) => Array.from(new Uint8Array(await (await fetch(`/api/files/${id}/export?format=odt`)).arrayBuffer())), docId);
  const zip = await JSZip.loadAsync(Buffer.from(bytes));
  const xml = await zip.file('content.xml').async('string');
  const marked = xml.replace(/<office:annotation (office:name="[^"]+")(?! loext:parent-name)/, '<office:annotation loext:resolved="true" $1'); // (the thread, not a reply)
  if (marked === xml) throw new Error('no annotation: ' + xml.slice(0, 300));
  zip.file('content.xml', marked);
  const b64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
  const up = await page.evaluate(async (data) => (await fetch('/api/files/upload?name=Resolved.odt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) })).json(), b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  const threads = (await api(page, 'GET', `/comments/${opened.body.id}`)).body;
  const root = threads.find((c) => !c.thread_id);
  if (!root || !root.resolved) throw new Error(JSON.stringify(threads.map((c) => [c.thread_id, c.resolved, c.body.split('\n')[0]])));
  await page.goto(`${B}/docs/${opened.body.id}`);
  await page.locator('.ProseMirror').getByText('12 percent').waitFor();
  await page.getByRole('button', { name: /Comments/ }).first().click();
  if (await page.getByText(/^Can we check this figure\?/).count()) throw new Error('a resolved thread is hidden');
  await page.getByLabel('Show resolved').check();
  await page.getByText(/^Can we check this figure\?/).first().waitFor();
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
