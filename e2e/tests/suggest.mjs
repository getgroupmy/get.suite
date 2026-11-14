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
  if (await pm(page).locator('ins.sugg-ins, del.sugg-del').count()) throw new Error('marks left');
  if (await page.getByRole('button', { name: /suggestions/ }).count()) throw new Error('button should go');
});
await step('back to editing: changes go straight in', async () => {
  await kim.getByLabel('Editing mode').selectOption('edit');
  await pm(kim).click();
  await kim.keyboard.press('End');
  await kim.keyboard.type(' Done');
  try { await until(async () => (await pm(page).innerText()).includes('We will deliver in April. Done')); } catch (e) { console.log('DBG', JSON.stringify((await pm(page).innerText()).slice(-60)), JSON.stringify((await pm(kim).innerText()).slice(-60))); throw e; }
  if (await pm(page).locator('ins.sugg-ins').count()) throw new Error('tracked in editing mode');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
