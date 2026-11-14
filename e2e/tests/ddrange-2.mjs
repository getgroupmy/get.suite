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
let sheetId, kim;
const cell = (p, k) => p.locator(`[data-k="${k}"]`);
const shownRows = (p) => p.locator('.grid-wrap tbody tr > th').allInnerTexts().then((l) => l.slice(0, 7).join(','));
const text = (p, k) => cell(p, k).innerText();
const tab = (p, n) => p.locator('.sheet-tab > button', { hasText: n }).first();
const content = async () => (await api(page, "GET", `/files/${sheetId}/content`)).body.content;
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
  const kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  const tasks = { A1: 'Job', B1: 'Status', A2: 'Logo', A3: 'Website', A4: 'Flyers' };
  const lists = { A1: 'Statuses', A2: 'Open', A3: 'Doing', A4: 'Done' };
  sheetId = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Jobs', content: { sheets: [{ name: 'Tasks', cells: tasks }, { name: 'Lists', cells: lists }] } })).body.id;
  await api(page, 'PUT', `/files/${sheetId}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  for (const p of [page, kim]) { await p.goto(`${B}/sheets/${sheetId}`); await cell(p, 'A4').getByText('Flyers').waitFor(); }
});
await step('a dropdown taking its choices from another tab, with a colour', async () => {
  await cell(page, 'B2').click();
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown');
  await page.getByRole('button', { name: 'Data validation' }).click();
  const dlg = page.getByRole('dialog', { name: 'Data validation' });
  await dlg.getByRole('radio', { name: 'A range of cells' }).click();
  await dlg.getByLabel('Choices from the cells').fill('lists!a2:a6');
  await until(async () => (await dlg.locator('[data-choice-count]').innerText()).startsWith('3 choices'));
  await dlg.getByText('Colours').click();
  await dlg.getByLabel('Colour for Done').selectOption({ label: 'Green' });
  await dlg.getByLabel('Colour for Open').selectOption({ label: 'Yellow' });
  await page.screenshot({ path: `${SP}/shots/ddrange-dialog.png` });
  await dlg.getByRole('button', { name: 'Add' }).click();
  await dlg.getByText('Dropdown from lists!A2:A6').waitFor();
  await page.keyboard.press('Escape');
  const v = await until(async () => (await content()).sheets[0].validations?.[0]);
  if (v.source !== 'lists!A2:A6' || v.values?.length || v.colors.Done !== '#ceead6') throw new Error(JSON.stringify(v));
});
await step('pick from it: the cell shows a coloured chip, for the other person too', async () => {
  await cell(page, 'B2').getByRole('button', { name: 'Choices for B2' }).click();
  const list = page.getByRole('listbox', { name: 'Choices' });
  if ((await list.getByRole('option').allInnerTexts()).join('|') !== 'Open|Doing|Done') throw new Error(await list.innerText());
  await list.getByRole('option', { name: 'Done' }).click();
  const chip = cell(page, 'B2').locator('.cell-chip');
  await until(async () => (await chip.count()) && (await chip.innerText()) === 'Done');
  if (await chip.evaluate((e) => getComputedStyle(e).backgroundColor) !== 'rgb(206, 234, 214)') throw new Error('colour');
  await until(async () => (await cell(kim, 'B2').locator('.cell-chip').count()) === 1);
  await page.screenshot({ path: `${SP}/shots/ddrange-chip.png` });
});
await step('adding to the list on the other tab adds it to the dropdown', async () => {
  await tab(kim, 'Lists').click();
  await cell(kim, 'A5').click();
  await kim.keyboard.type('Blocked'); await kim.keyboard.press('Enter');
  await until(async () => (await content()).sheets[1].cells.A5 === 'Blocked');
  await until(async () => {
    await cell(page, 'B3').getByRole('button', { name: 'Choices for B3' }).click();
    const names = await page.getByRole('listbox', { name: 'Choices' }).getByRole('option').allInnerTexts();
    await page.keyboard.press('Escape');
    return names.includes('Blocked');
  });
});
await step('typing follows the list: spelling fixed, others refused', async () => {
  await cell(page, 'B3').click();
  await page.keyboard.type('blocked'); await page.keyboard.press('Enter');
  await until(async () => (await text(page, 'B3')).includes('Blocked'));
  await cell(page, 'B4').click();
  await page.keyboard.type('Later'); await page.keyboard.press('Enter');
  await page.locator('.toast', { hasText: 'Choose one of: Open, Doing, Done, Blocked' }).waitFor({ timeout: 4000 }).catch(async (e) => { console.log('DBG', await page.locator('.toast').allInnerTexts(), await text(page, 'B4')); throw e; });
  await page.keyboard.press('Escape');
});
await step('renaming the tab and adding rows above the list keep the dropdown pointing at it', async () => {
  await tab(page, 'Lists').click();
  await cell(page, 'A1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Insert 1 row above/ }).click();
  await until(async () => (await content()).sheets[0].validations[0].source === 'lists!A3:A7');
  await page.getByRole('button', { name: 'Options for Lists' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const d = page.getByRole('dialog', { name: 'Rename sheet' });
  await d.getByLabel('Sheet name').fill('Q1 lists');
  await d.getByLabel('Sheet name').press('Enter');
  await until(async () => (await content()).sheets[0].validations[0].source === "'Q1 lists'!A3:A7");
  await tab(page, 'Tasks').click();
  await cell(page, 'B4').getByRole('button', { name: 'Choices for B4' }).click();
  const names = await page.getByRole('listbox', { name: 'Choices' }).getByRole('option').allInnerTexts();
  if (names.join('|') !== 'Open|Doing|Done|Blocked') throw new Error(names.join('|'));
  await page.keyboard.press('Escape');
});
await step('Excel keeps it as a range dropdown', async () => {
  const r = await page.evaluate(async (id) => { const x = await fetch(`/api/files/${id}/export?format=xlsx`); return { status: x.status, size: (await x.arrayBuffer()).byteLength }; }, sheetId);
  if (r.status !== 200 || r.size < 1000) throw new Error(JSON.stringify(r));
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
