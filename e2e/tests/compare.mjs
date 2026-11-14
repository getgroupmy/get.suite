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
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
let v2;
await step('setup: two versions of a contract and a Markdown draft', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Contract v1', content: { type: 'doc', content: [para('The fee is 400 pounds.'), para('Payment is monthly.'), para('Late fees apply.')] } });
  v2 = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Contract v2', content: { type: 'doc', content: [para('The fee is 500 pounds.'), para('Payment is monthly.')] } })).body.id;
  const up = await page.evaluate(async () => (await fetch('/api/files/upload?name=Draft.md', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: '# Draft\n\nThe fee is 500 pounds.\n\nPayment is weekly.' })).status);
  if (up !== 201 && up !== 200) throw new Error('upload ' + up);
  await page.goto(`${B}/docs/${v2}`);
  await page.getByText('The fee is 500 pounds.').waitFor();
});
const open = async (name) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Compare documents' }).click();
  const pick = page.getByRole('dialog', { name: 'Compare with…' });
  await pick.getByRole('button', { name }).click();
  const dlg = page.getByRole('dialog', { name: 'Compare documents' });
  await dlg.locator('.changes-summary').waitFor();
  return dlg;
};
await step('Compare with another document: what it has and leaves out', async () => {
  const pick = async () => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Compare documents' }).click();
    const d = page.getByRole('dialog', { name: 'Compare with…' });
    await d.getByRole('button', { name: /Contract v1/ }).waitFor();
    if (await d.getByRole('button', { name: /Contract v2/ }).count()) throw new Error('itself is offered');
    await d.getByRole('button', { name: /Contract v1/ }).click();
  };
  await pick();
  const dlg = page.getByRole('dialog', { name: 'Compare documents' });
  await dlg.getByText('From Contract v2 to Contract v1').waitFor();
  const summary = await dlg.locator('.changes-summary').innerText();
  if (!/Contract v1 has 4 words that Contract v2 doesn't, and leaves out 1 word\./.test(summary)) throw new Error(summary);
  const ins = await dlg.locator('.doc-changes ins').allInnerTexts();
  const del = await dlg.locator('.doc-changes del').allInnerTexts();
  if (!ins.join('|').includes('400') || !del.join('|').includes('500')) throw new Error(JSON.stringify({ ins, del }));
  await dlg.locator('.change-add', { hasText: 'Late fees apply.' }).waitFor();
  if (await dlg.locator('.change-add, .change-del, .change-edit', { hasText: 'Payment is monthly.' }).count()) throw new Error('unchanged paragraph marked');
});
await step('Swap and step through the changes', async () => {
  const dlg = page.getByRole('dialog', { name: 'Compare documents' });
  await dlg.getByRole('button', { name: '⇄ Swap' }).click();
  await dlg.getByText('From Contract v1 to Contract v2').waitFor();
  await dlg.locator('.change-del', { hasText: 'Late fees apply.' }).waitFor();
  if (!(await dlg.locator('.doc-changes ins').allInnerTexts()).join('|').includes('500')) throw new Error('swap');
  await dlg.getByRole('button', { name: '↓ Next change' }).click();
  await until(async () => (await dlg.locator('.change-current').count()) === 1);
  const first = await dlg.locator('.change-current').innerText();
  await dlg.getByRole('button', { name: '↓ Next change' }).click();
  await until(async () => (await dlg.locator('.change-current').innerText()) !== first);
  if (!(await dlg.locator('.change-current').innerText()).includes('Late fees')) throw new Error(await dlg.locator('.change-current').innerText());
  await dlg.getByRole('button', { name: '↑ Previous change' }).click();
  await until(async () => (await dlg.locator('.change-current').innerText()) === first);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await dlg.waitFor({ state: 'detached' });
});
await step('What you just typed counts; a Markdown file can be compared too', async () => {
  await page.locator('.ProseMirror p', { hasText: 'Payment is monthly.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Invoices by email.');
  const dlg = await open(/Draft\.md/);
  await dlg.getByText('From Contract v2 to Draft.md').waitFor();
  const ins = (await dlg.locator('.doc-changes ins').allInnerTexts()).join('|');
  const del = (await dlg.locator('.doc-changes del').allInnerTexts()).join('|');
  if (!ins.includes('weekly') || !del.includes('monthly') || !del.includes('Invoices')) throw new Error(JSON.stringify({ ins, del }));
  await dlg.locator('h1.change-add', { hasText: 'Draft' }).waitFor();
  await dlg.getByRole('button', { name: 'Close' }).click();
});
await step('The same text says so', async () => {
  const id = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Copy of v1', content: { type: 'doc', content: [para('The fee is 400 pounds.'), para('Payment is monthly.'), para('Late fees apply.')] } })).body.id;
  await page.goto(`${B}/docs/${id}`);
  await page.getByText('Late fees apply.').waitFor();
  const dlg = await open(/^Contract v1/);
  await dlg.getByText('The text of the two is the same.').waitFor();
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
