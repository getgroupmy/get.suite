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
let docId;
const text = () => page.locator('.ProseMirror').innerText();
const saved = async () => (await api(page, 'GET', `/files/${docId}/content`)).body.content;
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
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Letter' })).body.id;
  await page.goto(`${B}/docs/${docId}`);
  await page.locator('.ProseMirror').click();
});
await step('typing is autocorrected: quotes, dashes, symbols, fractions', async () => {
  await page.keyboard.type('She said "it\'s ready" -- about 1/2 done... (c) Acme -> next');
  await until(async () => (await text()).includes('She said “it’s ready” — about ½ done… © Acme → next')).catch(async (e) => { console.log('DBG1', JSON.stringify(await text())); throw e; });
});
await step('Backspace straight after a change keeps what was typed', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('a--');
  await until(async () => (await text()).includes('a—'));
  await page.keyboard.press('Backspace');
  await until(async () => (await text()).trimEnd().endsWith('a--'));
});
await step('Preferences: your own replacement, saved for you', async () => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Preferences' }).click();
  const dlg = page.getByRole('dialog', { name: 'Preferences' });
  await dlg.getByLabel('Replace').fill('addr');
  await dlg.getByLabel('With').fill('12 High Street, Leeds');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByRole('list', { name: 'Your replacements' }).getByText('12 High Street, Leeds').waitFor();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Send it to addr, please');
  await until(async () => (await text()).includes('Send it to 12 High Street, Leeds, please')).catch(async (e) => { console.log('DBG2', JSON.stringify(await text())); throw e; });
  const p = (await api(page, 'GET', '/doc-prefs')).body;
  if (p.subs[0]?.from !== 'addr') throw new Error(JSON.stringify(p));
});
await step('Capitalisation changes the selected text and keeps its formatting', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('the plan for ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('next year');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Shift+Home');
  await page.getByLabel('Capitalisation').selectOption('title');
  await until(async () => (await text()).includes('The Plan for Next Year'));
  await page.getByLabel('Capitalisation').selectOption('upper');
  await until(async () => (await text()).includes('THE PLAN FOR NEXT YEAR'));
  const bold = await page.locator('.ProseMirror strong').last().innerText();
  if (bold !== 'NEXT YEAR') throw new Error('bold kept: ' + bold);
  await page.screenshot({ path: `${SP}/shots/autocorrect.png` });
  await until(async () => JSON.stringify(await saved()).includes('THE PLAN FOR '));
});
await step('with autocorrect off, typing stays as it is', async () => {
  await api(page, 'PUT', '/doc-prefs', { autocorrect: false });
  await page.reload();
  await page.locator('.ProseMirror').getByText('Send it to').waitFor();
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('plain -- "quotes"');
  await until(async () => (await text()).includes('plain -- "quotes"'));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
