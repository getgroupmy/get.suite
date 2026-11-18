import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
import * as require_fs from 'node:fs';
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
let doc, kim;
const pm = (p) => p.locator('.ProseMirror');
const html = (p) => pm(p).innerHTML();
await step('a shared document', async () => {
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Proposal' })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await pm(page).click();
  await page.keyboard.type('We will deliver in March.');
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/docs/${doc.id}`);
  await pm(kim).getByText('We will deliver in March.').waitFor();
});
await step('Kim suggests: replaces a word and adds text', async () => {
  await kim.getByLabel('Editing mode').selectOption('suggest');
  await pm(kim).getByText('We will deliver in March.').dblclick({ position: { x: 5, y: 5 } }).catch(() => {});
  // Select "March" with the keyboard: end of line, then back over "March."
  await pm(kim).click();
  await kim.keyboard.press('End');
  await kim.keyboard.press('ArrowLeft');
  for (let i = 0; i < 5; i++) await kim.keyboard.press('Shift+ArrowLeft');
  await kim.keyboard.type('April');
  await kim.keyboard.press('End');
  await kim.keyboard.type(' Costs are fixed.');
  try { await until(async () => /<del[^>]*data-sugg[^>]*>March<\/del>/.test(await html(kim)) && /<ins[^>]*>April<\/ins>/.test(await html(kim))); } catch (e) { require_fs.writeFileSync(SP + '/sugg.html', await html(kim)); throw e; }
});
await step('Olivia sees them live, struck through and underlined, with who made them', async () => {
  await until(async () => /<del[^>]*>March<\/del>/.test(await html(page)) && /<ins[^>]*> Costs are fixed\.<\/ins>/.test(await html(page)));
  const title = await pm(page).locator('del.sugg-del').first().getAttribute('title');
  if (title !== 'Suggested by Kim Park') throw new Error(title);
  await page.getByRole('button', { name: /2 suggestions/ }).click();
  const panel = page.getByRole('complementary', { name: 'Suggestions' });
  await panel.getByText('Replace “March” with “April”').waitFor();
  await panel.getByText('Add “ Costs are fixed.”').waitFor();
});
await step('download leaves pending suggestions out', async () => {
  const md = await page.evaluate(async (id) => (await fetch(`/api/files/${id}/export?format=md`)).text(), doc.id);
  if (!md.includes('We will deliver in March.') || md.includes('April') || md.includes('Costs')) throw new Error(md);
});
await step('backspace in suggesting mode strikes through instead of deleting', async () => {
  await kim.keyboard.press('Home');
  await kim.keyboard.press('Delete');
  await kim.keyboard.press('Delete');
  await until(async () => /<del[^>]*>We<\/del>/.test(await html(kim)));
  if (!(await pm(kim).innerText()).startsWith('We will')) throw new Error('text was removed');
});
await step('Olivia accepts one, rejects another; everyone sees the result', async () => {
  const panel = page.getByRole('complementary', { name: 'Suggestions' });
  await panel.getByRole('button', { name: 'Accept: Replace “March” with “April”' }).click();
  await panel.getByRole('button', { name: 'Reject: Add “ Costs are fixed.”' }).click();
  await panel.getByRole('button', { name: 'Reject: Delete “We”' }).click();
  await until(async () => (await pm(kim).innerText()).trim() === 'We will deliver in April.');
  // (answered on the server: here too, live, a moment later)
  await until(async () => !(await pm(page).locator('ins.sugg-ins, del.sugg-del').count()), 10000).catch(() => { throw new Error('marks left'); });
  await until(async () => !(await page.getByRole('button', { name: /suggestions/ }).count()), 10000).catch(() => { throw new Error('button should go'); });
});
await step('back to editing: changes go straight in', async () => {
  await kim.getByLabel('Editing mode').selectOption('edit');
  await pm(kim).click();
  await kim.keyboard.press('End');
  await kim.keyboard.type(' Done');
  try { await until(async () => (await pm(page).innerText()).includes('We will deliver in April. Done')); } catch (e) { console.log('DBG', JSON.stringify((await pm(page).innerText()).slice(-60)), JSON.stringify((await pm(kim).innerText()).slice(-60))); throw e; }
  if (await pm(page).locator('ins.sugg-ins').count()) throw new Error('tracked in editing mode');
});
// Select these words in the editor (the first text node holding them), as a drag would.
const selectWords = (p, words) => pm(p).evaluate((el, w) => {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const at = n.data.indexOf(w);
    if (at < 0) continue;
    const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + w.length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return true;
  }
  throw new Error(`no “${w}”`);
}, words);
let rae;
const stored = async () => JSON.stringify((await api(page, 'GET', `/files/${doc.id}/content`)).body.content);
await step('a commenter suggests edits: what they type is their suggestion, live for the owner', async () => {
  const raeId = (await api(page, 'POST', '/users', { local: 'rae', domain: 'acme.com', name: 'Rae Reviewer', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Review me', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The fee is ten pounds.' }] }] } })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: raeId, role: 'commenter' }] });
  rae = await mk('rae'); await signIn(rae, 'rae@acme.com');
  await rae.goto(`${B}/docs/${doc.id}`);
  await rae.getByText('You can comment and suggest edits').waitFor();
  await page.goto(`${B}/docs/${doc.id}`);
  await pm(page).getByText('The fee is ten pounds.').waitFor();
  // Rae selects "ten" and types over it: a suggested replacement in her name.
  await pm(rae).getByText('The fee is ten pounds.').waitFor();
  await rae.waitForTimeout(800);
  await selectWords(rae, 'ten');
  await rae.keyboard.type('twelve');
  await pm(rae).locator('ins.sugg-ins', { hasText: 'twelve' }).waitFor();
  await pm(rae).locator('del.sugg-del', { hasText: 'ten' }).waitFor();
  // Olivia sees it live, by Rae; the server keeps it.
  const ins = pm(page).locator('ins.sugg-ins', { hasText: 'twelve' });
  await ins.waitFor({ timeout: 15000 });
  if (await ins.getAttribute('title') !== 'Suggested by Rae Reviewer') throw new Error(await ins.getAttribute('title'));
  await until(async () => /twelve/.test(await stored()), 15000);
}, { screenshot: (o) => (rae || page).screenshot(o) });
await step('a commenter can’t change the text outright: bold and a new paragraph are held back', async () => {
  await selectWords(rae, 'The');
  await rae.keyboard.press('Control+b');
  await rae.keyboard.press('End');
  await rae.keyboard.press('Enter');
  await rae.waitForTimeout(1500);
  if (await pm(rae).locator('strong').count()) throw new Error('bold went in');
  if (await pm(rae).locator('p').count() !== 1) throw new Error('a paragraph went in');
  const now = await stored();
  if (/"bold"/.test(now) || (now.match(/"paragraph"/g) || []).length !== 1 || !/twelve/.test(now)) throw new Error(now);
}, { screenshot: (o) => (rae || page).screenshot(o) });
await step('the owner accepts the commenter’s suggestion', async () => {
  await page.getByRole('button', { name: /1 suggestions/ }).click();
  await page.getByRole('button', { name: 'Accept: Replace “ten” with “twelve”' }).click();
  await pm(page).getByText('The fee is twelve pounds.').waitFor();
  await pm(rae).getByText('The fee is twelve pounds.').waitFor();
  if (await pm(rae).locator('.sugg-ins, .sugg-del').count()) throw new Error('marks left');
  // Rae hears of it in her bell (in the top bar, outside the editor).
  await rae.goto(`${B}/home`);
  await rae.getByRole('button', { name: /^Notifications/ }).click();
  await rae.getByText('Olivia Owner accepted your suggestion in “Review me”').waitFor();
  await rae.getByText('Replace “ten” with “twelve”').first().waitFor();
}, { screenshot: (o) => (rae || page).screenshot(o) });
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
