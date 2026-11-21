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
const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const OL = (items) => ({ type: 'orderedList', content: items.map((t) => ({ type: 'listItem', content: [P(t)] })) });
const UL = (items) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [P(t)] })) });
const lookOf = (p, tag, text) => p.locator(`.paper .tiptap ${tag}`, { hasText: text }).first().evaluate((el) => getComputedStyle(el).listStyleType);
let docId, kim;
await step('setup: a document with a numbered and a bulleted list, shared with an editor', async () => {
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
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [P('Steps:'), OL(['Unpack', 'Plug in']), P('Shopping:'), UL(['Milk', 'Eggs'])] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const pg of [page, kim]) { await pg.goto(`${B}/docs/${docId}`); await pg.getByText('Eggs').waitFor(); }
});
await step('in a numbered list: Numbering style → i. ii. iii.; the other editor sees it', async () => {
  await page.getByText('Steps:').click();
  await until(async () => (await page.getByLabel('Numbering style').count()) === 0 && (await page.getByLabel('Bullet style').count()) === 0);
  await page.getByText('Plug in').click();
  if (await page.getByLabel('Numbering style').inputValue() !== 'decimal') throw new Error('starts as 1. 2. 3.');
  await page.getByLabel('Numbering style').selectOption({ label: 'i. ii. iii.' });
  await until(async () => (await lookOf(page, 'ol', 'Unpack')) === 'lower-roman');
  await until(async () => (await lookOf(kim, 'ol', 'Unpack')) === 'lower-roman');
});
await step('in a bulleted list: Bullet style → ✓ Tick; the other editor sees it', async () => {
  await page.getByText('Eggs').click();
  if (await page.getByLabel('Bullet style').inputValue() !== 'disc') throw new Error('starts as ●');
  await page.getByLabel('Bullet style').selectOption({ label: '✓ Tick' });
  await until(async () => (await lookOf(page, 'ul', 'Milk')) === '"✓ "');
  await until(async () => (await lookOf(kim, 'ul', 'Milk')) === '"✓ "');
  await page.screenshot({ path: `${SP}/shots/list-styles.png` });
});
await step('kept: after reloading, both still look so', async () => {
  await page.waitForTimeout(2500); // saved
  await page.reload();
  await page.getByText('Eggs').waitFor();
  if ((await lookOf(page, 'ol', 'Unpack')) !== 'lower-roman' || (await lookOf(page, 'ul', 'Milk')) !== '"✓ "') throw new Error('lost');
});
for (const format of ['docx', 'odt']) await step(`${format === 'docx' ? 'a Word' : 'an OpenDocument'} download opened again keeps them`, async () => {
  const up = await page.evaluate(async ([id, f]) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=${f}`)).arrayBuffer();
    return (await fetch(`/api/files/upload?name=Plan%20copy.${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
  }, [docId, format]);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  const lists = (await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content.content.filter((n) => /List$/.test(n.type)).map((n) => n.attrs?.listStyle || n.attrs?.bullet);
  if (lists.join() !== 'lower-roman,check') throw new Error(`${format}: ${lists.join()}`);
});
await step('a list with another inside it: a Word download LibreOffice saves as .odt opens as one list, the other inside', async () => {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { console.log('(LibreOffice is not installed here: skipped)'); return; }
  const fs = await import('node:fs'); const path = await import('node:path');
  const nested = { type: 'orderedList', attrs: { listStyle: 'lower-alpha' }, content: ['Point a', 'Point b'].map((t) => ({ type: 'listItem', content: [P(t)] })) };
  const outer = { type: 'orderedList', attrs: { listStyle: 'upper-roman' }, content: [{ type: 'listItem', content: [P('Intro'), nested] }, { type: 'listItem', content: [P('Body')] }] };
  const id = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Outline', content: { type: 'doc', content: [outer] } })).body.id;
  const bytes = await page.evaluate(async (i) => [...new Uint8Array(await (await fetch(`/api/files/${i}/export?format=docx`)).arrayBuffer())], id);
  const dir = fs.mkdtempSync(path.join(SP, 'lo-'));
  fs.writeFileSync(path.join(dir, 'Outline.docx'), Buffer.from(bytes));
  execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'odt', '--outdir', path.join(dir, 'out'), path.join(dir, 'Outline.docx')], { stdio: 'ignore', timeout: 120000 });
  const odt = [...fs.readFileSync(path.join(dir, 'out', 'Outline.odt'))];
  fs.rmSync(dir, { recursive: true, force: true });
  const up = await page.evaluate(async (b) => (await fetch('/api/files/upload?name=Outline.odt', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: new Uint8Array(b) })).json(), odt);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  await page.goto(`${B}/docs/${opened.body.id}`);
  await page.getByText('Point b').waitFor();
  const shape = await page.locator('.paper .tiptap').evaluate((ed) => [...ed.children].filter((c) => /^[OU]L$/.test(c.tagName)).map((l) => `${getComputedStyle(l).listStyleType}[${[...l.children].map((li) => li.querySelector('p').textContent + ([...li.querySelectorAll(':scope > ol')].map((o) => `(${getComputedStyle(o).listStyleType}:${o.children.length})`).join(''))).join(',')}]`).join(' '));
  if (shape !== 'upper-roman[Intro(lower-alpha:2),Body]') throw new Error(shape);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
