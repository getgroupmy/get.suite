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
const row = (n) => page.locator('.files tbody tr', { hasText: n }).first();
let kim, doc;
await step('setup: Olivia makes a document, renames it, moves it and shares it with Kim, who edits it', async () => {
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
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Board' })).body;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Draft' })).body;
  await api(page, 'PATCH', `/files/${doc.id}`, { name: 'Board pack' });
  await api(page, 'PATCH', `/files/${doc.id}`, { parent_id: folder.id });
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const cur = (await api(kim, 'GET', `/files/${doc.id}`)).body;
  const r = await api(kim, 'PUT', `/files/${doc.id}/content`, { version: cur.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Agenda' }] }] } });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
});
await step('Details shows the activity, newest first, in words', async () => {
  await kim.goto(`${B}/drive/shared`);
  const rowK = kim.locator('.files tbody tr', { hasText: 'Board pack' }).first();
  await rowK.getByRole('button', { name: 'Actions for Board pack' }).click();
  await kim.getByRole('menuitem', { name: 'Details' }).click();
  const list = kim.getByRole('dialog', { name: 'Details' }).getByRole('list', { name: 'Activity' });
  await list.waitFor();
  const lines = (await list.locator('li > span:first-child').allInnerTexts());
  const want = ['Kim Park edited it', 'Olivia Owner shared it with Kim Park (can edit)', 'Olivia Owner moved it to Board', 'Olivia Owner renamed it from Draft to Board pack', 'Olivia Owner created it'];
  if (lines.join('|') !== want.join('|')) throw new Error(lines.join('|'));
  await kim.screenshot({ path: `${SP}/shots/activity.png` });
});
await step('trash and restore are added (seen by the owner, after the 5 latest behind Show all)', async () => {
  await api(page, 'PATCH', `/files/${doc.id}`, { trashed: true });
  await api(page, 'PATCH', `/files/${doc.id}`, { trashed: false });
  await page.goto(`${B}/drive`);
  await page.locator('.files tbody tr', { hasText: 'Board' }).first().dblclick();
  await row('Board pack').getByRole('button', { name: 'Actions for Board pack' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const dlg = page.getByRole('dialog', { name: 'Details' });
  const list = dlg.getByRole('list', { name: 'Activity' });
  await list.getByText('Olivia Owner restored it from the trash').waitFor();
  if ((await list.locator('li').count()) !== 5) throw new Error('5 first');
  await dlg.getByRole('button', { name: 'Show all 7' }).click();
  await list.getByText('Olivia Owner created it').waitFor();
});
await step('a folder’s Details lists what happened inside it, naming each item', async () => {
  const top = (await api(page, 'POST', '/files/folder', { name: 'Project room' })).body.id;
  const inner = (await api(page, 'POST', '/files/folder', { name: 'Drafts corner', parent_id: top })).body.id;
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Pitch', parent_id: inner })).body.id;
  await api(page, 'PATCH', `/files/${d}`, { name: 'Pitch final' });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Project room' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  const list = page.getByRole('dialog', { name: 'Details' }).getByRole('list', { name: 'Activity' });
  await list.getByText('Olivia Owner renamed “Pitch final” from Pitch to Pitch final').waitFor();
  await list.getByText('Olivia Owner created “Drafts corner”').waitFor();
  await list.getByText('Olivia Owner created it', { exact: true }).waitFor({ timeout: 1500 }).catch(async () => {
    await page.getByRole('dialog', { name: 'Details' }).getByRole('button', { name: /^Show all/ }).click();
    await list.getByText('Olivia Owner created it', { exact: true }).waitFor();
  });
  await page.screenshot({ path: `${SP}/shots/folder-activity.png` });
});
await step('an item’s name in a folder’s activity opens it; Show older brings the rest', async () => {
  const dlg = page.getByRole('dialog', { name: 'Details' });
  await dlg.getByRole('button', { name: '“Drafts corner”' }).first().click();
  await page.waitForURL(/\/drive\/folder\//);
  if (await page.getByRole('dialog', { name: 'Details' }).count()) throw new Error('Details still open');
  await page.getByText('Pitch final').first().waitFor();
  // Lots happening: more than 100 entries.
  const busy = (await api(page, 'POST', '/files/folder', { name: 'Busy room' })).body.id;
  const d = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'r0', parent_id: busy })).body.id;
  for (let i = 1; i <= 104; i++) await api(page, 'PATCH', `/files/${d}`, { name: `r${i}` });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Busy room' }).click();
  await page.getByRole('menuitem', { name: 'Details' }).click();
  await dlg.getByRole('button', { name: 'Show all 100' }).click();
  await dlg.getByRole('button', { name: 'Show older' }).click();
  await dlg.getByText('Olivia Owner created it', { exact: true }).waitFor();
  if (await dlg.getByRole('button', { name: 'Show older' }).count()) throw new Error('nothing older left');
  await dlg.getByRole('button', { name: 'Show less' }).waitFor();
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
