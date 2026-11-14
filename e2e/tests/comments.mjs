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
let docId, sheetId, kim, vic, dir;

await step('setup: a document and a spreadsheet shared with an editor and a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [local, name] of [['kim', 'Kim Park'], ['vic', 'Vic Viewer'], ['sam', 'Sam Stone']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  dir = (await api(page, 'GET', '/users/directory')).body;
  const idOf = (e) => dir.find((u) => u.username === e).id;
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Budget for next year' }] }] } })).body.id;
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Numbers' })).body.id;
  for (const id of [docId, sheetId]) await api(page, 'PUT', `/files/${id}/shares`, { shares: [{ user_id: idOf('kim@acme.com'), role: 'editor' }, { user_id: idOf('vic@acme.com'), role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('Budget for next year').waitFor(); }
});

let threadId;
await step('select text, comment, and @mention a colleague from the suggestions', async () => {
  await page.locator('.paper .tiptap').click();
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowLeft'); // "next year"
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByText('On “next year”').waitFor();
  const box = page.getByLabel('New comment');
  await box.type('Is this right @ki');
  await page.getByRole('listbox', { name: 'People to mention' }).getByText('Kim Park').waitFor();
  await page.keyboard.press('Enter');
  if (await box.inputValue() !== 'Is this right @kim@acme.com ') throw new Error(`box: ${await box.inputValue()}`);
  await box.type('please check');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByText('kim@acme.com was told by chat').waitFor();
  await page.locator('.comment-thread .mention', { hasText: '@kim@acme.com' }).waitFor();
  threadId = await page.locator('.paper [data-comment]').first().getAttribute('data-comment');
  if (await page.locator('.paper [data-comment]').textContent() !== 'next year') throw new Error('mark text');
  await page.screenshot({ path: `${SP}/shots/comments-doc.png` });
});

await step('the others see the comment and the highlighted text live', async () => {
  for (const p of [kim, vic]) {
    await p.locator(`.paper [data-comment="${threadId}"]`).waitFor();
    await p.getByRole('button', { name: /1\s*Comments/ }).waitFor();
  }
});

await step('the mentioned person gets a chat message with a link to the comment', async () => {
  const chans = (await api(kim, 'GET', '/chat/channels')).body.channels;
  const dm = chans.find((c) => c.dm_key);
  const msgs = (await api(kim, 'GET', `/chat/channels/${dm.id}/messages`)).body;
  if (!msgs.some((m) => m.body.includes('Mentioned you in a comment on “Plan”') && m.body.includes(`/docs/${docId}?comment=${threadId}`))) throw new Error('no DM');
  await kim.goto(`${B}/chat/${dm.id}`);
  await kim.getByRole('link', { name: `/docs/${docId}?comment=${threadId}` }).click();
  await kim.locator('.comments-panel').waitFor();
  await kim.locator('.comment-thread.active').getByText('please check').waitFor();
  await kim.getByLabel('Reply').waitFor();
});

await step('a reply shows up for everyone; resolving hides the thread', async () => {
  await kim.getByLabel('Reply').fill('Yes, it is right');
  await kim.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.locator('.comment-thread').getByText('Yes, it is right').waitFor();
  await page.locator('.comment-thread').click();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await page.getByText('Resolved by Olivia Owner').waitFor(); // still shown: it's the selected one
  await kim.locator('.comment-thread').getByText('Resolved by Olivia Owner').waitFor(); // kim has it open, so it stays
  await vic.getByRole('button', { name: 'Comments', exact: true }).waitFor(); // no open comments left
  await page.getByLabel('Show resolved').check();
  await page.getByRole('button', { name: 'Reopen' }).waitFor();
  await page.getByLabel('Show resolved').uncheck();
});

await step('a reply reopens a resolved thread', async () => {
  await page.getByLabel('Show resolved').check();
  await page.getByLabel('Reply').fill('One more thing');
  await page.getByLabel('Reply').press('Control+Enter');
  await kim.locator('.comment-thread').getByText('One more thing').waitFor();
  await page.getByRole('button', { name: 'Resolve' }).waitFor();
});

await step('mentioning someone the file is not shared with says so', async () => {
  await page.locator('.comment-thread').click();
  await page.getByLabel('Reply').fill('@sam@acme.com fyi');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByText("sam@acme.com can't open this file, so they weren't told").waitFor();
});

await step('viewers read comments but cannot add or reply', async () => {
  await vic.getByRole('button', { name: /Comments/ }).click();
  await vic.locator('.comment-thread').getByText('please check').waitFor();
  await vic.locator('.comment-thread').click();
  if (await vic.getByLabel('Reply').count()) throw new Error('viewer can reply');
  if (await vic.getByRole('button', { name: 'Add comment' }).count()) throw new Error('viewer can comment');
  if (await vic.getByRole('button', { name: /^Delete comment/ }).count()) throw new Error('viewer can delete');
});

await step('Cancel removes the highlight of an unfinished comment', async () => {
  await page.locator('.paper .tiptap').click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight');

  await page.keyboard.press('Control+Alt+KeyM');
  await page.getByText('On “Budget”').waitFor();
  if (await page.locator('.paper [data-comment]').count() !== 2) throw new Error('no pending mark');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await until(async () => (await page.locator('.paper [data-comment]').count()) === 1);
});

await step('deleting a thread removes its highlight for everyone', async () => {
  await page.locator('.comment-thread').click();
  await page.getByRole('button', { name: 'Delete comment by Olivia Owner' }).first().click();
  await page.getByText('Select something and press Comment').waitFor();
  await until(async () => (await kim.locator('.paper [data-comment]').count()) === 0);
  const c = await api(page, 'GET', `/comments/${docId}`);
  if (c.body.length) throw new Error('replies remain');
});

await step('Sheets: comment on a cell; others see a marker and jump to it', async () => {
  await page.goto(`${B}/sheets/${sheetId}`);
  await kim.goto(`${B}/sheets/${sheetId}`);
  await page.locator('[data-k="C4"]').click();
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByText('On C4').waitFor();
  await page.getByLabel('New comment').fill('Fill in the total here');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.locator('[data-k="C4"] .cell-comment').waitFor();
  await kim.locator('[data-k="C4"] .cell-comment').waitFor();
  await kim.getByRole('button', { name: /1\s*Comments/ }).click();
  await kim.locator('.comment-thread').getByText('Fill in the total here').waitFor();
  await kim.locator('.comment-where', { hasText: 'C4' }).click();
  await until(async () => (await kim.locator('.cell-name').inputValue()) === 'C4');
  await page.screenshot({ path: `${SP}/shots/comments-sheet.png` });
});

await step('Sheets: clicking a cell with a comment opens it', async () => {
  await kim.getByRole('button', { name: 'Close comments' }).click();
  await kim.locator('[data-k="A1"]').click();
  await kim.locator('[data-k="C4"]').click();
  await kim.locator('.comment-thread.active').getByText('Fill in the total here').waitFor();
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
