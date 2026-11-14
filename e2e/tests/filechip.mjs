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
let doc, sheet, folder;
const chip = (p, text) => p.locator('.ProseMirror .doc-filechip', { hasText: text });
await step('@ and part of a file name offers Drive files; picking one puts in a chip', async () => {
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget 2027' })).body;
  folder = (await api(page, 'POST', '/files/folder', { name: 'Budget papers' })).body;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Budget memo' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type('Figures are in @budg');
  const list = page.getByRole('listbox', { name: 'People, dates and files' });
  await list.getByRole('option', { name: /Budget 2027/ }).waitFor();
  await list.getByRole('option', { name: /Budget papers/ }).waitFor();
  if (await list.getByRole('option', { name: /Budget memo/ }).count()) throw new Error('offers the document itself');
  await page.screenshot({ path: `${SP}/shots/filechip-picker.png` });
  await list.getByRole('option', { name: /Budget 2027/ }).click();
  await chip(page, 'Budget 2027').waitFor();
  await page.keyboard.type('for next year.');
  await page.locator('.ProseMirror', { hasText: 'Figures are in 📊 Budget 2027 for next year.' }).waitFor();
});
await step('a folder too, with the keyboard', async () => {
  await page.keyboard.type(' Background: @papers');
  await page.getByRole('listbox', { name: 'People, dates and files' }).getByRole('option', { name: /Budget papers/ }).waitFor();
  await page.keyboard.press('Enter');
  await chip(page, 'Budget papers').waitFor();
  await page.screenshot({ path: `${SP}/shots/filechip-doc.png` });
});
await step('clicking a chip opens the file', async () => {
  const [opened] = await Promise.all([page.context().waitForEvent('page'), chip(page, 'Budget 2027').click()]);
  await opened.waitForURL(new RegExp(`/sheets/${sheet.id}$`));
  await opened.close();
  const [f] = await Promise.all([page.context().waitForEvent('page'), chip(page, 'Budget papers').click()]);
  await f.waitForURL(new RegExp(`/drive/folder/${folder.id}$`));
  await f.close();
});
await step('kept after reload, and found by search', async () => {
  await page.waitForTimeout(1500);
  await page.reload();
  await chip(page, 'Budget 2027').waitFor();
  await until(async () => (await api(page, 'GET', `/files?view=search&q=${encodeURIComponent('Budget papers')}`)).body.some((f) => f.id === doc.id));
});
const paste = (t) => page.evaluate((text) => { const dt = new DataTransfer(); dt.setData('text/plain', text); document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, t);
await step('a pasted link to a file becomes its chip; one that can\'t be opened stays a link', async () => {
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Kickoff deck' })).body;
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Slides: ');
  await paste(`${B}/slides/${deck.id}`);
  await chip(page, 'Kickoff deck').waitFor();
  if (!/📽/.test(await chip(page, 'Kickoff deck').innerText())) throw new Error('no slides icon');
  await page.keyboard.type(' Old: ');
  await paste(`${B}/docs/nosuchfile1`);
  await page.locator('.ProseMirror', { hasText: `Old: ${B}/docs/nosuchfile1` }).waitFor();
  await page.waitForTimeout(800);
  if (await chip(page, 'nosuch').count()) throw new Error('made a chip');
  await page.screenshot({ path: `${SP}/shots/filechip-paste.png` });
});
console.log(errors.length ? `ERRORS\n${errors.join('\n')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
