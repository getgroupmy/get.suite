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
let docId, kim;
const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const OL = (items) => ({ type: 'orderedList', content: items.map((t) => ({ type: 'listItem', content: [P(t)] })) });
const numbersOf = (p, text) => p.locator('.paper .tiptap ol', { hasText: text }).first().evaluate((ol) => [...ol.children].map((li, i) => (ol.start || 1) + i).join(','));
await step('setup: a document with two numbered lists, shared with an editor', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Steps', content: { type: 'doc', content: [P('Before you start:'), OL(['Unpack', 'Plug in', 'Switch on']), P('A note in between.'), OL(['Log in', 'Set the clock'])] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const pg of [page, kim]) { await pg.goto(`${B}/docs/${docId}`); await pg.getByText('Set the clock').waitFor(); }
});
await step('outside a numbered list there is no numbering box; inside, it shows where the list starts', async () => {
  await page.getByText('A note in between.').click();
  await until(async () => (await page.getByLabel('Numbering starts at').count()) === 0);
  await page.getByText('Log in').click();
  await until(async () => (await page.getByLabel('Numbering starts at').count()) === 1);
  if ((await page.getByLabel('Numbering starts at').inputValue()) !== '1') throw new Error('starts at 1');
});
await step('Continue numbering: the second list carries on (4, 5); the other editor sees it', async () => {
  await page.getByRole('button', { name: 'Continue numbering' }).click();
  await until(async () => (await numbersOf(page, 'Log in')) === '4,5');
  await until(async () => (await numbersOf(kim, 'Log in')) === '4,5');
  if ((await page.getByLabel('Numbering starts at').inputValue()) !== '4') throw new Error('box shows 4');
  if (await page.getByRole('button', { name: 'Continue numbering' }).count()) throw new Error('already carries on');
  await page.screenshot({ path: `${SP}/shots/list-continue.png` });
});
await step('Start at a number of your own; Restart at 1', async () => {
  await page.getByLabel('Numbering starts at').fill('10');
  await until(async () => (await numbersOf(page, 'Log in')) === '10,11');
  await page.getByRole('button', { name: 'Restart at 1' }).click();
  await until(async () => (await numbersOf(page, 'Log in')) === '1,2');
  await page.getByRole('button', { name: 'Continue numbering' }).click();
  await until(async () => (await numbersOf(kim, 'Log in')) === '4,5');
});
await step('Word and .odt downloads keep each list’s numbers, and so does LibreOffice', async () => {
  await page.waitForTimeout(2500); // saved
  const starts = (d) => d.content.filter((n) => n.type === 'orderedList').map((n) => n.attrs?.start ?? 1).join(',');
  for (const format of ['docx', 'odt']) {
    const up = await page.evaluate(async ([id, f]) => {
      const bytes = await (await fetch(`/api/files/${id}/export?format=${f}`)).arrayBuffer();
      return (await fetch(`/api/files/upload?name=Steps%20copy.${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    }, [docId, format]);
    const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
    const back = starts((await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content);
    if (back !== '1,4') throw new Error(`${format}: ${back}`);
  }
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { console.log('(LibreOffice is not installed here: its part skipped)'); return; }
  const fs = await import('node:fs'); const path = await import('node:path');
  const bytes = await page.evaluate(async (id) => [...new Uint8Array(await (await fetch(`/api/files/${id}/export?format=docx`)).arrayBuffer())], docId);
  const dir = fs.mkdtempSync(path.join(SP, 'lo-'));
  fs.writeFileSync(path.join(dir, 'Steps.docx'), Buffer.from(bytes));
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'txt:Text', '--outdir', path.join(dir, 'out'), path.join(dir, 'Steps.docx')], { stdio: 'ignore', timeout: 120000 });
  const text = fs.readFileSync(path.join(dir, 'out', 'Steps.txt'), 'utf8').replace(/\s+/g, ' ');
  fs.rmSync(dir, { recursive: true, force: true });
  // (each list numbered on its own: before, Word's numbers ran on from one list to the next by themselves)
  if (!/1\. Unpack 2\. Plug in 3\. Switch on A note in between\. 4\. Log in 5\. Set the clock/.test(text)) throw new Error(text);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
