import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let kim, sheet, doc;
const cell = (p, k) => p.locator(`.grid td[data-k="${k}"]`);
await step('share a spreadsheet with Kim as Commenter from the Share dialog', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Rent', B1: '1000' } }] } })).body;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Proposal', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The price is ten thousand.' }] }] } })).body;
  await page.goto(`${B}/drive`);
  for (const name of ['Budget', 'Proposal']) {
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    await page.getByRole('menuitem', { name: 'Share' }).click();
    const d = page.getByRole('dialog', { name: new RegExp(`Share “${name}”`) });
    await d.getByLabel('Email address').fill('kim@acme.com');
    await d.getByLabel('Access', { exact: true }).selectOption('commenter');
    await d.getByRole('button', { name: 'Add' }).click();
    if (await d.getByLabel('Access for Kim Park', { exact: true }).inputValue() !== 'commenter') throw new Error('role');
    await d.getByLabel('Message to Kim Park (optional)').fill(`Please look at the ${name === 'Budget' ? 'rent' : 'price'}`);
    await d.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Sharing updated').waitFor();
  }
});
await step('Kim is told, with the message', async () => {
  const k = await mk('kim-bell'); await signIn(k, 'kim@acme.com');
  await k.goto(`${B}/home`);
  await k.getByRole('button', { name: /^Notifications/ }).click();
  await k.getByText('“Please look at the rent” · You can comment').waitFor();
  // Kept with the file: in Shared with me, and its Details.
  await k.goto(`${B}/drive/shared`);
  await k.locator('tr', { hasText: 'Budget' }).getByText('“Please look at the rent”').waitFor();
  await k.getByRole('button', { name: 'Actions for Budget' }).click();
  await k.getByRole('menuitem', { name: 'Details' }).click();
  await k.getByRole('dialog').getByText('Olivia Owner shared it with you: “Please look at the rent”.').waitFor();
  // Opening it shows the message at the top until she closes it.
  await k.goto(`${B}/sheets/${sheet.id}`);
  const note = k.getByRole('note').filter({ hasText: 'Olivia Owner shared it with you: “Please look at the rent”' });
  await note.waitFor();
  await note.getByRole('button', { name: 'Close the message' }).click();
  await k.reload();
  await k.locator('.grid').waitFor();
  await k.waitForTimeout(800);
  if (await k.getByRole('note').filter({ hasText: 'shared it with you' }).count()) throw new Error('shown again');
});
await step('Kim can comment on a cell but not change it', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/sheets/${sheet.id}`);
  await kim.getByText('You can comment, not edit.').waitFor();
  await cell(kim, 'B1').click();
  await kim.keyboard.type('9');
  await kim.keyboard.press('Enter');
  if ((await cell(kim, 'B1').innerText()).trim() !== '1000') throw new Error('changed');
  await cell(kim, 'B1').click();
  await kim.getByRole('button', { name: 'Comment on B1' }).click();
  await kim.getByLabel('New comment').fill('Is rent going up?');
  await kim.getByRole('button', { name: 'Comment', exact: true }).click();
  await kim.getByRole('complementary', { name: 'Comments' }).getByText('Is rent going up?').waitFor();
  await until(async () => (await api(page, 'GET', `/comments/${sheet.id}`)).body.some((c) => c.body === 'Is rent going up?'));
});
await step('in a document too: select text, Comment', async () => {
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByText('You can comment and suggest edits').waitFor();
  const p = kim.locator('.ProseMirror p', { hasText: 'The price is ten thousand.' });
  await p.waitFor();
  await p.evaluate((el) => { const t = el.firstChild; const r = document.createRange(); r.setStart(t, 4); r.setEnd(t, 9); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await kim.getByRole('button', { name: 'Comment', exact: true }).first().click();
  await kim.getByLabel('New comment').fill('Which price?');
  await kim.getByRole('complementary', { name: 'Comments' }).getByRole('button', { name: 'Comment', exact: true }).click();
  await kim.getByRole('complementary', { name: 'Comments' }).getByText('Which price?').waitFor();
  const c = (await api(page, 'GET', `/comments/${doc.id}`)).body.find((x) => x.body === 'Which price?');
  if (c.anchor.quote !== 'price') throw new Error(JSON.stringify(c.anchor));
});
await step('everyone at the company as Commenter, from the Share dialog', async () => {
  const d2 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Handbook' })).body;
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Handbook' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const d = page.getByRole('dialog', { name: /Share “Handbook”/ });
  await d.getByLabel('Access for everyone at Acme Trading').selectOption('commenter');
  await page.getByText('Everyone at Acme Trading can comment on it').waitFor();
  await kim.goto(`${B}/docs/${d2.id}`);
  await kim.getByText('You can comment and suggest edits').waitFor();
});
await step('a commenter asks for edit access from the banner; the owner gives it in Drive; the document opens editable', async () => {
  // Its details in Drive say what Kim can do, with the same button.
  await kim.goto(`${B}/drive/shared`);
  await kim.getByRole('button', { name: `Actions for ${(await api(kim, 'GET', `/files/${doc.id}`)).body.name}` }).click();
  await kim.getByRole('menuitem', { name: 'Details' }).click();
  await kim.getByText('You can comment on it').waitFor();
  await kim.getByRole('dialog').getByRole('button', { name: 'Request edit access' }).waitFor();
  await kim.keyboard.press('Escape');
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByRole('button', { name: 'Request edit access' }).click();
  await kim.getByText('Asked Olivia Owner for edit access.').first().waitFor();
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: /^Access requests/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Access requests' });
  await dlg.getByText('asks to edit').waitFor();
  await dlg.getByText('(can comment now)').waitFor();
  await dlg.getByRole('button', { name: 'Share' }).click();
  await dlg.getByText('Nobody is waiting.').waitFor();
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.locator('.ProseMirror[contenteditable="true"]').waitFor();
  if (await kim.getByRole('button', { name: 'Request edit access' }).count()) throw new Error('still asks');
  await kim.goto(`${B}/home`);
  await kim.getByRole('button', { name: /^Notifications/ }).click();
  await kim.getByText('Olivia Owner gave you edit access to').first().waitFor();
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
