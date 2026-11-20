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
let ch, kim;
await step('setup: a channel and a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  ch = (await api(page, 'POST', '/chat/channels', { name: 'office' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Morning all' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/chat/${ch}`); await p.getByText('Morning all').waitFor(); }
});
await step('a link to a document shared with Kim shows as a card; one not shared offers to ask for access', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((p) => p.username === 'kim@acme.com').id;
  const shared = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Q4 numbers' })).body;
  const secret = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Salary review' })).body;
  await api(page, 'PUT', `/files/${shared.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: `Numbers are in ${B}/sheets/${shared.id} and notes in /docs/${secret.id}` });
  const msg = kim.locator('.msg', { hasText: 'Numbers are in' });
  const card = msg.getByRole('link', { name: 'Spreadsheet: Q4 numbers' });
  await card.waitFor();
  await card.getByText('Spreadsheet · Olivia Owner · you can edit').waitFor();
  await msg.getByRole('link', { name: /A file you can’t open/ }).waitFor();
  if (await msg.getByText('Salary review').count()) throw new Error('name leaked');
  // A document Kim can comment on says so.
  const review = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'For review' })).body;
  await api(page, 'PUT', `/files/${review.id}/shares`, { shares: [{ user_id: kimId, role: 'commenter' }] });
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: `Please look at /docs/${review.id}` });
  await kim.locator('.msg', { hasText: 'Please look at' }).getByRole('link', { name: 'Document: For review' }).getByText('Document · Olivia Owner · you can comment').waitFor();
  await kim.screenshot({ path: `${SP}/shots/file-cards.png` });
  // Olivia sees both by name.
  await page.locator('.msg', { hasText: 'Numbers are in' }).getByRole('link', { name: 'Document: Salary review' }).waitFor();
});
await step('the card opens the file; the other leads to asking for access', async () => {
  await kim.locator('.msg', { hasText: 'Numbers are in' }).getByRole('link', { name: 'Spreadsheet: Q4 numbers' }).click();
  await kim.waitForURL(/\/sheets\//);
  await kim.goBack();
  await kim.locator('.msg', { hasText: 'Numbers are in' }).getByRole('link', { name: /A file you can’t open/ }).click();
  await kim.getByRole('heading', { name: 'You need access' }).waitFor();
});
await step('an uploaded file’s link (/drive?preview=…) shows as a card too and opens its preview', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((p) => p.username === 'kim@acme.com').id;
  const up = await page.request.post(`${B}/api/files/upload?name=scan.txt`, { headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, data: 'scanned' });
  const f = await up.json();
  await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await kim.goto(`${B}/chat/${ch}`);
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: `The scan: ${B}/drive?preview=${f.id}` });
  const card = kim.locator('.msg', { hasText: 'The scan:' }).getByRole('link', { name: 'File: scan.txt' });
  await card.waitFor();
  await card.click();
  await kim.getByRole('dialog').getByText('scan.txt').first().waitFor();
});
await step('a link to cells on a sheet: the card says which, and opens the spreadsheet there', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((p) => p.username === 'kim@acme.com').id;
  const book = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Year plan', content: { sheets: [{ name: 'Intro', cells: { A1: 'Hi' } }, { name: 'Costs', cells: { B2: '450' } }] } })).body;
  await api(page, 'PUT', `/files/${book.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: `Check ${B}/sheets/${book.id}#sheet=Costs&range=B2 please` });
  await kim.goto(`${B}/chat/${ch}`);
  const card = kim.locator('.msg', { hasText: 'Check' }).getByRole('link', { name: 'Spreadsheet: Year plan (Sheet “Costs”, B2)' });
  await card.getByText('Sheet “Costs”, B2').waitFor();
  await card.click();
  await kim.waitForURL(/\/sheets\/.*#sheet=Costs&range=B2/);
  await kim.locator('[data-k="B2"]').getByText('450').waitFor();
  await until(async () => (await kim.getByLabel('Name box').inputValue()) === 'B2');
});
await step('a link to a slide or a document\'s heading: the card says which (Slide 2, the heading\'s words)', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((p) => p.username === 'kim@acme.com').id;
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Kickoff deck', content: { slides: [{ id: 'k1', items: [] }, { id: 'k2', items: [] }] } })).body;
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Kickoff notes', content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Next steps' }] }] } })).body;
  for (const f of [deck, doc]) await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: `See ${B}/slides/${deck.id}#slide=k2 and /docs/${doc.id}#next-steps` });
  await kim.goto(`${B}/chat/${ch}`);
  const msg = kim.locator('.msg', { hasText: 'See' }).last();
  await msg.getByRole('link', { name: 'Presentation: Kickoff deck (Slide 2)' }).waitFor();
  await msg.getByRole('link', { name: 'Document: Kickoff notes (“Next steps”)' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
