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
const ctx = page.context();
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
let sheetId;
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
const editor = () => page.locator('.ProseMirror').first();
const contentText = async (id) => JSON.stringify((await api(page, 'GET', `/files/${id}/content`)).body?.content || '');
let doc;
await step('open a document once (it is kept on this device), type, go offline, keep typing', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Field notes', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Start.' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await editor().getByText('Start.').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // the worker now runs this page: everything it loads is kept
  await editor().getByText('Start.').waitFor();
  await editor().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Online words.');
  await until(async () => (await contentText(doc.id)).includes('Online words'), 15000);
  await page.waitForTimeout(1500);
  await ctx.setOffline(true);
  await page.getByText(/You're offline/).waitFor({ timeout: 20000 });
  await page.keyboard.type(' Offline words.');
  await page.waitForTimeout(1500);
});
await step('reloaded without a connection, the app opens and the document comes from this device, with the offline words', async () => {
  await page.reload();
  await editor().getByText(/Offline words/).waitFor({ timeout: 20000 });
  await page.getByText(/You're offline \(opened from this device\)/).waitFor();
  await editor().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' After reload.');
  await page.waitForTimeout(1500);
});
await step('back online: what was written offline reaches the server, once', async () => {
  await ctx.setOffline(false);
  await until(async () => { const t = await contentText(doc.id); return t.includes('Offline words') && t.includes('After reload'); }, 30000);
  const t = await contentText(doc.id);
  if ((t.match(/Start\./g) || []).length !== 1 || (t.match(/Online words/g) || []).length !== 1) throw new Error(`repeated: ${t}`);
  await page.getByText(/You're offline/).waitFor({ state: 'detached', timeout: 15000 });
});
await step('changed elsewhere while offline: the offline words become an offline copy, the document isn’t repeated', async () => {
  await ctx.setOffline(true);
  await page.getByText(/You're offline/).waitFor({ timeout: 20000 });
  await editor().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Train words.');
  await page.waitForTimeout(2500);
  // Meanwhile someone else's change from outside (a version restored, an import): the server rebuilds the document.
  const other = await (await browser.newContext()).newPage();
  await other.goto(B);
  await other.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'olivia@acme.com', password: 'password123' }) }));
  const v = (await api(other, 'GET', `/files/${doc.id}`)).body.version;
  const put = await api(other, 'PUT', `/files/${doc.id}/content`, { version: v, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rewritten elsewhere.' }] }] } });
  if (put.status !== 200) throw new Error(JSON.stringify(put));
  await ctx.setOffline(false);
  const banner = page.getByRole('alert').filter({ hasText: 'changed elsewhere while you were offline' });
  await banner.waitFor({ timeout: 30000 });
  await banner.getByRole('link', { name: 'Field notes (offline copy)' }).waitFor();
  const files = (await api(page, 'GET', '/files')).body;
  const copies = (Array.isArray(files) ? files : files.files || []).filter((f) => /^Field notes \(offline copy\)/.test(f.name));
  if (copies.length !== 1) throw new Error(`${copies.length} copies: ${copies.map((f) => f.name)}`);
  const copy = copies[0];
  if (!copy || !(await contentText(copy.id)).includes('Train words')) throw new Error('no offline copy with the words');
  const t = await contentText(doc.id);
  if (t.includes('Train words') || (t.match(/Rewritten elsewhere/g) || []).length !== 1) throw new Error(`original: ${t}`);
  await page.screenshot({ path: `${SP}/shots/offline-copy.png` });
  await banner.getByRole('button', { name: 'Open the latest version' }).click();
  await editor().getByText('Rewritten elsewhere.').waitFor();
  if (await editor().getByText(/Train words/).count()) throw new Error('old copy merged after reload');
});
await step('Sheets: a cell typed offline is there after reloading offline, and reaches the server when back online', async () => {
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', cells: { A1: 'Rent', B1: '900' } }] } })).body;
  const cell = (k) => page.locator(`[data-k="${k}"]`);
  await page.goto(`${B}/sheets/${sh.id}`);
  await cell('A1').getByText('Rent').waitFor();
  await page.waitForTimeout(1500); // kept on the device a moment after it syncs
  await ctx.setOffline(true);
  await cell('A2').click();
  await page.keyboard.type('Food');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.reload();
  await cell('A2').getByText('Food').waitFor({ timeout: 20000 });
  await page.getByText(/You're offline \(opened from this device\)/).waitFor();
  await ctx.setOffline(false);
  await until(async () => (await api(page, 'GET', `/files/${sh.id}/content`)).body?.content?.sheets?.[0]?.cells?.A2 === 'Food', 30000);
});
await step('Slides: a presentation opened before opens without a connection', async () => {
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch', content: { theme: 'light', slides: [{ id: 's1', items: [{ id: 't', type: 'text', x: 5, y: 5, w: 60, h: 12, text: 'Our pitch' }] }] } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByText('Our pitch').first().waitFor();
  await page.waitForTimeout(1500);
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('Our pitch').first().waitFor({ timeout: 20000 });
  await page.getByText(/You're offline \(opened from this device\)/).waitFor();
  await ctx.setOffline(false);
  await page.getByText(/You're offline/).first().waitFor({ state: 'detached', timeout: 20000 });
});
await step('Drive without a connection lists the files kept on this device, with any not sent yet, and opens them', async () => {
  await page.goto(`${B}/drive`);
  await page.getByText('Budget', { exact: true }).first().waitFor();
  await ctx.setOffline(true);
  await page.reload();
  const list = page.getByRole('region', { name: 'Files on this device' });
  await list.getByText(/These files are kept on this device/).waitFor({ timeout: 20000 });
  for (const name of ['Field notes', 'Budget', 'Pitch']) await list.getByRole('link', { name }).waitFor();
  await list.getByRole('link', { name: 'Budget' }).click();
  await page.locator('[data-k="A2"]').getByText('Food').waitFor({ timeout: 20000 });
  await page.locator('[data-k="A3"]').click();
  await page.keyboard.type('Travel');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.goto(`${B}/drive`);
  await list.getByRole('listitem').filter({ hasText: 'Budget' }).getByText('Not sent yet').waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SP}/shots/on-this-device.png` });
  await ctx.setOffline(false);
  await page.getByRole('region', { name: 'Files on this device' }).waitFor({ state: 'detached', timeout: 20000 });
  await page.getByText('Budget', { exact: true }).first().waitFor(); // the real list again
  await page.getByText('Sent what you changed offline in 1 file').waitFor({ timeout: 20000 }); // without opening it
  await until(async () => { const r = await api(page, 'GET', '/files'); const b = (Array.isArray(r.body) ? r.body : r.body?.files || []).find((f) => f.name === 'Budget'); return b && (await api(page, 'GET', `/files/${b.id}/content`)).body?.content?.sheets?.[0]?.cells?.A3 === 'Travel'; }, 30000);
});
await step('Calendar, Tasks, Contacts and Notes show what was last seen here when offline', async () => {
  const at = new Date(); at.setHours(15, 0, 0, 0);
  await api(page, 'POST', '/events', { title: 'Site visit', start: at.getTime(), end: at.getTime() + 36e5 });
  const list = (await api(page, 'POST', '/tasks/lists', { name: 'Trip' })).body.id;
  await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title: 'Book the ferry' });
  await api(page, 'POST', '/contacts', { name: 'Harbour Office', email: 'office@harbour.example' });
  await api(page, 'POST', '/notes', { title: 'Packing list', body: 'Boots' });
  const pages = [['/calendar', 'Site visit'], ['/tasks', 'Book the ferry'], ['/contacts', 'Harbour Office'], ['/notes', 'Packing list']];
  for (const [path, text] of pages) { await page.goto(B + path); await page.getByText(text).first().waitFor(); await page.waitForTimeout(500); }
  await ctx.setOffline(true);
  for (const [path, text] of pages) {
    await page.goto(B + path);
    await page.getByText(text).first().waitFor({ timeout: 20000 });
    await page.getByText(/Showing what was last saved on this device/).waitFor();
  }
  await page.screenshot({ path: `${SP}/shots/offline-tasks.png` });
  await ctx.setOffline(false);
  await page.getByText(/Showing what was last saved/).waitFor({ state: 'detached', timeout: 20000 });
});
await step('signing out clears what was kept on this device', async () => {
  const count = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { if (!r.result.objectStoreNames.contains('docs')) { r.result.close(); res(0); return; } const c = r.result.transaction('docs').objectStore('docs').count(); c.onsuccess = () => { res(c.result); r.result.close(); }; }; }));
  await until(async () => (await count()) > 0, 10000); // the document open now is kept (a moment after it syncs)
  await page.goto(`${B}/settings`);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).or(page.getByRole('button', { name: 'Sign out' })).first().click();
  await page.getByRole('button', { name: /^Sign in/ }).waitFor();
  if (await count()) throw new Error('still kept after signing out');
});
await step('someone else signing in on this browser (the last person’s session over) gets nothing of theirs offline', async () => {
  await api(page, 'POST', '/auth/login', { username: 'olivia@acme.com', password: 'password123' });
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  await page.goto(`${B}/docs/${doc.id}`);
  await editor().getByText('Rewritten elsewhere.').waitFor();
  await page.goto(`${B}/tasks`);
  await page.getByText('Book the ferry').first().waitFor();
  const count = (store) => page.evaluate((st) => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { if (!r.result.objectStoreNames.contains(st)) { r.result.close(); res(0); return; } const c = r.result.transaction(st).objectStore(st).count(); c.onsuccess = () => { res(c.result); r.result.close(); }; }; }), store);
  await until(async () => (await count('docs')) > 0 && (await count('api')) > 0, 10000);
  await ctx.clearCookies(); // Olivia's session ended (time limit), without signing out
  await page.goto(B);
  await page.getByLabel('Email').fill('kim@acme.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.reload();
  const oliviaId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'olivia@acme.com').id;
  const keys = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { if (!r.result.objectStoreNames.contains('api')) { r.result.close(); res([]); return; } const g = r.result.transaction('api').objectStore('api').getAllKeys(); g.onsuccess = () => { res(g.result); r.result.close(); }; }; }));
  await until(async () => (await count('docs')) === 0 && !(await keys()).some((k) => k.startsWith(`${oliviaId}:`)), 10000); // Kim's own pages may keep their own
  await ctx.setOffline(true);
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByText(/hasn’t been opened on this device before/).waitFor({ timeout: 20000 });
  await ctx.setOffline(false);
});
await step('no errors in the browser', async () => { const real = errors.filter((e) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|WebSocket/.test(e)); if (real.length) throw new Error(real.join(' | ')); });
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors.slice(0, 3)));
await browser.close();
process.exit(failed ? 1 : 0);
