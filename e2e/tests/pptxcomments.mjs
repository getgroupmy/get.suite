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
let deckId;
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
await step('comments in a PowerPoint file open as threads on their slides', async () => {
  const b64 = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/office/commented.pptx`).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Plan.pptx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  await page.goto(`${B}/slides/${opened.body.id}`);
  await page.getByText('Our plan').first().waitFor();
  await page.getByRole('button', { name: /Comments/ }).first().click();
  await page.getByText(/^Make the title shorter/).first().waitFor();
  await page.getByText('— Raj & Co (in the PowerPoint file)').first().waitFor();
  await page.getByText('Slide 1').first().waitFor();
  if (await page.getByText(/^Swap these two charts/).count()) throw new Error('the resolved one should be hidden');
  await page.getByLabel('Show resolved').check();
  await page.getByText(/^Swap these two charts/).first().waitFor();
  await page.getByText('Slide 2').first().waitFor();
  await page.screenshot({ path: `${SP}/shots/pptx-comments.png` });
  deckId = opened.body.id;
});
await step('the .odp download keeps the slide comments and replies; reopened, they are threads on the same slides', async () => {
  const threads = (await api(page, 'GET', `/comments/${deckId}`)).body;
  const root = threads.find((c) => !c.thread_id && c.body.startsWith('Make the title shorter'));
  if ((await api(page, 'POST', `/comments/${deckId}`, { body: 'Shortened it.', thread_id: root.id })).status !== 201) throw new Error('reply');
  const up = await page.evaluate(async (id) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=odp`)).arrayBuffer();
    return (await fetch('/api/files/upload?name=Plan.odp', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
  }, deckId);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  const back = (await api(page, 'GET', `/comments/${opened.body.id}`)).body;
  const r2 = back.find((c) => !c.thread_id && c.body.startsWith('Make the title shorter'));
  if (!r2 || !/— Olivia Owner \(in the OpenDocument file\)$/.test(r2.body)) throw new Error(JSON.stringify(back.map((c) => c.body)));
  const replies = back.filter((c) => c.thread_id === r2.id).map((c) => c.body.split('\n')[0]);
  if (!replies.includes('Shortened it.')) throw new Error('replies ' + JSON.stringify(replies));
  const slides = (await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content.slides;
  const anchor = typeof r2.anchor === 'string' ? JSON.parse(r2.anchor) : r2.anchor;
  if (anchor?.slide !== slides[0].id) throw new Error('on slide 1: ' + JSON.stringify(r2.anchor));
  await page.goto(`${B}/slides/${opened.body.id}`);
  await page.getByText('Our plan').first().waitFor();
  await page.getByRole('button', { name: /Comments/ }).first().click();
  await page.getByText(/^Make the title shorter/).first().waitFor();
  await page.getByText(/^Shortened it\./).first().waitFor();
  await page.getByText('— Olivia Owner (in the OpenDocument file)').first().waitFor();
});
await step('a PowerPoint download saved again by LibreOffice keeps the reply as a reply', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore' }); } catch { console.log('(LibreOffice not installed: skipped)'); return; }
  const bytes = await page.evaluate(async (id) => Array.from(new Uint8Array(await (await fetch(`/api/files/${id}/export?format=pptx`)).arrayBuffer())), deckId);
  const dir = fs.mkdtempSync(`${SP}/lo-`);
  fs.writeFileSync(`${dir}/in.pptx`, Buffer.from(bytes));
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pptx', '--outdir', `${dir}/out`, `${dir}/in.pptx`], { stdio: 'ignore', timeout: 120000 });
  const b64 = fs.readFileSync(`${dir}/out/in.pptx`).toString('base64');
  const up = await page.evaluate(async (data) => (await fetch('/api/files/upload?name=Plan-LO.pptx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) })).json(), b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  const back = (await api(page, 'GET', `/comments/${opened.body.id}`)).body;
  const root = back.find((c) => !c.thread_id && c.body.startsWith('Make the title shorter'));
  if (!root || !back.some((c) => c.thread_id === root.id && c.body.startsWith('Shortened it.'))) throw new Error(JSON.stringify(back.map((c) => [c.thread_id, c.body.split('\n')[0]])));
  if (back.some((c) => !c.thread_id && c.body.startsWith('Shortened it.'))) throw new Error('the reply is also a thread');
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
