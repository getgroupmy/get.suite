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
await step('Tasks: a task ticked offline stays ticked here (even after reloading) and is done on the server once back', async () => {
  await page.goto(`${B}/tasks`);
  await page.getByText('Trip').first().click();
  const box = page.getByLabel('Done: Book the ferry');
  await box.waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await box.click(); // done: it moves into Completed
  await page.getByText(/“Book the ferry” done: saved on this device/).waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByText('Trip').first().click().catch(() => {});
  await page.getByText('Completed (1)').waitFor({ timeout: 20000 }); // still done after reloading offline
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  const lists = (await api(page, 'GET', '/tasks/lists')).body;
  const trip = (Array.isArray(lists) ? lists : lists.lists).find((l) => l.name === 'Trip');
  await until(async () => ((await api(page, 'GET', `/tasks/lists/${trip.id}/tasks?done=1`)).body || []).concat((await api(page, 'GET', '/tasks/completed?days=7')).body || []).some((t) => t.title === 'Book the ferry' && t.done), 10000);
});
await step('Notes: a note changed offline keeps the change here (even after reloading) and on the server once back', async () => {
  await page.goto(`${B}/notes`);
  await page.getByText('Packing list').first().waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByText('Packing list').first().click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Note').fill('Boots and a rain jacket');
  await d.getByRole('button', { name: 'Close' }).last().click();
  await page.getByText('Boots and a rain jacket').first().waitFor();
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByText('Boots and a rain jacket').first().waitFor({ timeout: 20000 }); // the kept list shows the change
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  await until(async () => ((await api(page, 'GET', '/notes')).body || []).some((n) => n.title === 'Packing list' && n.body === 'Boots and a rain jacket'), 10000);
});
await step('a task and a note made offline show here (even after reloading) and are made once on the server when back', async () => {
  await page.goto(`${B}/tasks`);
  await page.getByText('Trip').first().click();
  await page.getByLabel('Add a task').waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByLabel('Add a task').fill('Buy sun cream');
  await page.keyboard.press('Enter');
  await page.getByText(/“Buy sun cream” added on this device/).waitFor({ timeout: 15000 });
  await page.getByLabel('Done: Buy sun cream').waitFor();
  await page.reload();
  await page.getByText('Trip').first().click().catch(() => {});
  await page.getByLabel('Done: Buy sun cream').waitFor({ timeout: 20000 }); // still there after reloading offline
  await page.locator('li.task', { hasText: 'Buy sun cream' }).getByText('Not sent yet').waitFor(); // marked so
  await page.goto(`${B}/notes`).catch(() => {});
  await page.getByRole('button', { name: 'Take a note…' }).click({ timeout: 20000 });
  await page.getByLabel('Title').fill('Ferry times');
  await page.getByLabel('Take a note').fill('08:15 and 17:40');
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByText('Note saved on this device').waitFor({ timeout: 15000 });
  await page.getByRole('article', { name: 'Ferry times' }).waitFor();
  await page.reload();
  await page.getByRole('article', { name: 'Ferry times' }).waitFor({ timeout: 20000 });
  await page.getByRole('article', { name: 'Ferry times' }).getByText('Not sent yet').waitFor();
  await ctx.setOffline(false);
  await page.getByText('Sent 2 changes made offline').waitFor({ timeout: 30000 });
  await until(async () => ((await api(page, 'GET', '/notes')).body || []).filter((n) => n.title === 'Ferry times' && n.body === '08:15 and 17:40').length === 1, 10000);
  const lists = (await api(page, 'GET', '/tasks/lists')).body;
  const trip = (Array.isArray(lists) ? lists : lists.lists).find((l) => l.name === 'Trip');
  const made = ((await api(page, 'GET', `/tasks/lists/${trip.id}/tasks`)).body || []).filter((t) => t.title === 'Buy sun cream');
  if (made.length !== 1) throw new Error(`${made.length} tasks`);
  await page.getByRole('article', { name: 'Ferry times' }).waitFor(); // the list reloaded from the server keeps it
  await page.getByRole('article', { name: 'Ferry times' }).getByText('Not sent yet').waitFor({ state: 'detached', timeout: 10000 }); // sent: no longer marked
});
await step('Calendar: an event made offline shows here (even after reloading) and is made once when back', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByText('Site visit').first().waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByRole('button', { name: 'Create' }).click();
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByLabel('Title').fill('Ferry to the island');
  await dlg.getByLabel('Start time').fill('10:00');
  await dlg.getByLabel('End time').fill('11:00');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/“Ferry to the island” saved on this device/).waitFor({ timeout: 15000 });
  await dlg.waitFor({ state: 'detached' });
  await page.getByText('Ferry to the island').first().waitFor();
  await page.reload();
  await page.getByText('Ferry to the island').first().waitFor({ timeout: 20000 }); // still there after reloading offline
  await page.locator('.ev-offline', { hasText: 'Ferry to the island' }).first().waitFor(); // drawn as not sent yet
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  const day = new Date(); day.setHours(0, 0, 0, 0);
  await until(async () => ((await api(page, 'GET', `/events?from=${day.getTime()}&to=${day.getTime() + 2 * 864e5}`)).body || []).filter((e) => e.title === 'Ferry to the island').length === 1, 10000); // (made late in the evening, the dialog starts tomorrow)
  await page.getByText('Ferry to the island').first().waitFor(); // reloaded from the server
  await page.locator('.ev-offline').first().waitFor({ state: 'detached', timeout: 10000 });
});
await step('Contacts: someone added offline is in the list (even after reloading) and added once when back', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByText('Harbour Office').first().waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByRole('button', { name: 'New contact' }).click();
  const dlg = page.getByRole('dialog', { name: 'New contact' });
  await dlg.getByLabel('Name', { exact: true }).fill('Island Taxi');
  await dlg.getByLabel('Phone', { exact: true }).fill('+44 1234 567890');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Island Taxi saved on this device').waitFor({ timeout: 15000 });
  await dlg.waitFor({ state: 'detached' });
  await page.getByText('Island Taxi').first().waitFor();
  await page.reload();
  await page.getByText('Island Taxi').first().waitFor({ timeout: 20000 }); // still there after reloading offline
  await page.locator('tr', { hasText: 'Island Taxi' }).getByText('Not sent yet').waitFor();
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  await until(async () => ((await api(page, 'GET', '/contacts')).body || []).filter((c) => c.name === 'Island Taxi' && c.phone === '+44 1234 567890').length === 1, 10000);
  await page.getByText('Island Taxi').first().waitFor(); // reloaded from the server
  await page.locator('tr', { hasText: 'Island Taxi' }).getByText('Not sent yet').waitFor({ state: 'detached', timeout: 10000 });
});
await step('an event and a contact changed offline show the change here (even after reloading) and on the server once back', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByText('Site visit').first().waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByText('Site visit').first().click();
  const dlg = page.getByRole('dialog', { name: 'Edit event' });
  await dlg.getByLabel('Title').fill('Site visit with the surveyor');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/“Site visit with the surveyor” changed on this device/).waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByText('Site visit with the surveyor').first().waitFor({ timeout: 20000 });
  await page.goto(`${B}/contacts`).catch(() => {});
  await page.getByRole('button', { name: 'Edit Harbour Office' }).click({ timeout: 20000 });
  const cd = page.getByRole('dialog', { name: 'Edit contact' });
  await cd.getByLabel('Phone', { exact: true }).fill('+44 1111 222333');
  await cd.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Harbour Office changed on this device').waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByText('+44 1111 222333').first().waitFor({ timeout: 20000 }); // the kept list has the change
  await page.locator('tr', { hasText: 'Harbour Office' }).getByText('Not sent yet').waitFor();
  await ctx.setOffline(false);
  await page.getByText('Sent 2 changes made offline').waitFor({ timeout: 30000 });
  await until(async () => ((await api(page, 'GET', '/contacts')).body || []).some((c) => c.name === 'Harbour Office' && c.phone === '+44 1111 222333'), 10000);
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const evs = (await api(page, 'GET', `/events?from=${day.getTime()}&to=${day.getTime() + 864e5}`)).body || [];
  if (!evs.some((e) => e.title === 'Site visit with the surveyor') || evs.some((e) => e.title === 'Site visit')) throw new Error(JSON.stringify(evs.map((e) => e.title)));
});
await step('a task, a note and a contact deleted offline are gone here (even after reloading) and deleted on the server once back', async () => {
  await page.goto(`${B}/tasks`);
  await page.getByText('Trip').first().click();
  await page.getByText('Buy sun cream').first().waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByText('Buy sun cream').first().click();
  await page.getByRole('complementary', { name: 'Task details' }).getByRole('button', { name: 'Delete task' }).click();
  await page.getByText(/“Buy sun cream” deleted on this device/).waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByText('Trip').first().click().catch(() => {});
  await page.getByText('Completed (1)').waitFor({ timeout: 20000 }); // the list is there (its one task done)
  if (await page.getByLabel('Done: Buy sun cream').count()) throw new Error('task back after reloading');
  await page.goto(`${B}/notes`).catch(() => {});
  const card = page.getByRole('article', { name: 'Ferry times' });
  await card.getByRole('button', { name: 'More' }).click({ timeout: 20000 });
  await page.getByRole('menuitem', { name: 'Delete note' }).click();
  await page.getByText('Note deleted on this device').waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByText('Packing list').first().waitFor({ timeout: 20000 });
  if (await card.count()) throw new Error('note back after reloading');
  await page.goto(`${B}/contacts`).catch(() => {});
  await page.getByRole('button', { name: 'Delete Island Taxi' }).click({ timeout: 20000 });
  await page.getByRole('dialog', { name: 'Delete contact?' }).getByRole('button', { name: /^Delete/ }).click();
  await page.getByText('Island Taxi deleted on this device').waitFor({ timeout: 15000 });
  await page.reload();
  await page.getByText('Harbour Office').first().waitFor({ timeout: 20000 });
  if (await page.getByText('Island Taxi', { exact: true }).count()) throw new Error('contact back after reloading');
  await ctx.setOffline(false);
  await page.getByText('Sent 3 changes made offline').waitFor({ timeout: 30000 });
  const lists = (await api(page, 'GET', '/tasks/lists')).body;
  const trip = (Array.isArray(lists) ? lists : lists.lists).find((l) => l.name === 'Trip');
  if (((await api(page, 'GET', `/tasks/lists/${trip.id}/tasks`)).body || []).some((t) => t.title === 'Buy sun cream')) throw new Error('task still on the server');
  if (((await api(page, 'GET', '/notes')).body || []).some((n) => n.title === 'Ferry times')) throw new Error('note still on the server');
  if (!((await api(page, 'GET', '/notes?trash=1')).body || []).some((n) => n.title === 'Ferry times')) throw new Error('note not in the trash');
  if (((await api(page, 'GET', '/contacts')).body || []).some((c) => c.name === 'Island Taxi')) throw new Error('contact still on the server');
});
await step('a change sent while the server is restarting (503) stays on the device and goes on the next try', async () => {
  await page.goto(`${B}/notes`);
  await page.getByText('Packing list').first().waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByText('Packing list').first().click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Note').fill('Boots, rain jacket and a torch');
  await d.getByRole('button', { name: 'Close' }).last().click();
  await page.getByText('Boots, rain jacket and a torch').first().waitFor();
  await page.waitForTimeout(800);
  let refused = 0;
  const restarting = (route) => (route.request().method() === 'PATCH' ? (refused++, route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Workspace is restarting"}' })) : route.continue());
  await page.route('**/api/notes/*', restarting);
  await ctx.setOffline(false);
  await until(async () => refused > 0, 30000);
  await page.waitForTimeout(1500);
  if (await page.getByText(/couldn’t be made/).count()) throw new Error('the change was dropped');
  const queued = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const c = r.result.transaction('changes').objectStore('changes').count(); c.onsuccess = () => { res(c.result); r.result.close(); }; }; }));
  if ((await queued()) !== 1) throw new Error(`queued: ${await queued()}`);
  await page.unroute('**/api/notes/*', restarting);
  await page.reload(); // the next try (also when the network or the live connection comes back)
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  await until(async () => ((await api(page, 'GET', '/notes')).body || []).some((n) => n.title === 'Packing list' && n.body === 'Boots, rain jacket and a torch'), 10000);
  if ((await queued()) !== 0) throw new Error('still queued');
});
await step('Drive: a new document made offline is written in here, kept after reloading, and made in Drive with its words when back', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'New' }).waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Document' }).click();
  await page.waitForURL(/\/docs\/off/);
  const id = new URL(page.url()).pathname.split('/').pop();
  await editor().click();
  await page.keyboard.type('Notes from the island');
  await page.getByLabel('File name').fill('Island notes'); // renamed offline too
  await page.getByLabel('File name').press('Enter');
  await page.waitForTimeout(1500); // kept on the device
  await page.reload();
  await editor().getByText('Notes from the island').waitFor({ timeout: 20000 }); // from this device
  if ((await page.getByLabel('File name').inputValue()) !== 'Island notes') throw new Error('the name went back');
  await page.goto(`${B}/drive`).catch(() => {});
  await page.getByText('Island notes').first().waitFor({ timeout: 20000 }); // listed with the files kept here
  await ctx.setOffline(false);
  await page.getByText('Sent 2 changes made offline').waitFor({ timeout: 30000 });
  await page.getByText(/Sent what you changed offline in 1 file/).waitFor({ timeout: 30000 });
  await until(async () => {
    const r = await api(page, 'GET', `/files/${id}/content`);
    return r.status === 200 && JSON.stringify(r.body.content).includes('Notes from the island');
  }, 15000);
  const { file, content: doc } = (await api(page, 'GET', `/files/${id}/content`)).body;
  if (file.name !== 'Island notes') throw new Error(`named ${file.name}`);
  const blocks = doc.content[0]?.type === 'docTab' ? doc.content[0].content : doc.content;
  if (blocks.length !== 1 || blocks[0]?.content?.[0]?.text !== 'Notes from the island') throw new Error(JSON.stringify(doc)); // no empty line with it
});
await step('Drive: a new spreadsheet made offline is filled in here and made in Drive, with one sheet, when back', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'New' }).waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Spreadsheet' }).click();
  await page.waitForURL(/\/sheets\/off/);
  const id = new URL(page.url()).pathname.split('/').pop();
  const cell = (k) => page.locator(`[data-k="${k}"]`);
  await cell('A1').click({ timeout: 20000 });
  await page.keyboard.type('Fuel');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await page.reload();
  await cell('A1').getByText('Fuel').waitFor({ timeout: 20000 }); // kept on the device
  await page.goto(`${B}/drive`).catch(() => {});
  await page.getByText('Untitled spreadsheet').first().waitFor({ timeout: 20000 });
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  await until(async () => (await api(page, 'GET', `/files/${id}/content`)).body?.content?.sheets?.[0]?.cells?.A1 === 'Fuel', 30000);
  const { sheets } = (await api(page, 'GET', `/files/${id}/content`)).body.content;
  if (sheets.length !== 1) throw new Error(`${sheets.length} sheets: ${sheets.map((x) => x.name).join(', ')}`);
});
await step('Drive: a new presentation made offline gets its title here and is made in Drive, with that one slide, when back', async () => {
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'New' }).waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Presentation' }).click();
  await page.waitForURL(/\/slides\/off/);
  const id = new URL(page.url()).pathname.split('/').pop();
  await page.getByText('Click to add title').dblclick({ timeout: 20000 });
  await page.keyboard.type('Ferry plan');
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(1500);
  await page.reload();
  await page.locator('.slide-stage').getByText('Ferry plan').waitFor({ timeout: 20000 }); // kept on the device
  await ctx.setOffline(false);
  await page.getByText(/Sent 1 change made offline/).waitFor({ timeout: 30000 });
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${id}/content`)).body?.content?.slides || []).includes('Ferry plan'), 30000);
  const { slides } = (await api(page, 'GET', `/files/${id}/content`)).body.content;
  if (slides.length !== 1) throw new Error(`${slides.length} slides`);
});
await step('Drive offline: a kept file renamed there gets the name when back; one can be taken off the device', async () => {
  await page.goto(`${B}/drive`);
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.reload();
  const kept = page.getByRole('region', { name: 'Files on this device' }).or(page.locator('section.on-this-device'));
  await kept.getByRole('link', { name: 'Island notes' }).waitFor({ timeout: 20000 });
  const islandId = (await kept.getByRole('link', { name: 'Island notes' }).getAttribute('href')).split('/').pop();
  await kept.getByRole('button', { name: 'More for Island notes' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.getByRole('dialog', { name: 'Rename' }).getByLabel('Name').fill('Island notes, final');
  await page.getByRole('dialog', { name: 'Rename' }).getByRole('button', { name: 'Rename' }).click();
  await page.getByText('Renamed on this device').waitFor({ timeout: 15000 });
  await kept.getByRole('link', { name: 'Island notes, final' }).waitFor();
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  await until(async () => (await api(page, 'GET', `/files/${islandId}/content`)).body?.file?.name === 'Island notes, final', 10000);
  // Taken off the device: not listed there any more (it opens from the server when connected).
  await ctx.setOffline(true);
  await page.reload();
  await kept.getByRole('button', { name: 'More for Island notes, final' }).click({ timeout: 20000 });
  await page.getByRole('menuitem', { name: 'Remove from this device' }).click();
  await page.getByText('is no longer kept on this device').waitFor();
  await kept.getByRole('link', { name: 'Island notes, final' }).waitFor({ state: 'detached' });
  await ctx.setOffline(false);
});
await step('Drive: Make available offline keeps a file never opened here, which then opens without a connection', async () => {
  const made = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Ferry timetable', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Departures at 7, 9 and 11' }] }] } })).body;
  await page.goto(`${B}/drive`);
  const row = page.locator('tr', { hasText: 'Ferry timetable' });
  await row.getByRole('button', { name: 'Actions for Ferry timetable' }).click();
  await page.getByRole('menuitem', { name: 'Make available offline' }).click();
  await page.getByText('“Ferry timetable” is available offline on this device').waitFor({ timeout: 20000 });
  await row.getByLabel('Available offline').waitFor();
  // Changed on the server later: brought up to date here in the background while connected (at most hourly: the last
  // fetch is made to look old).
  const { file: cur } = (await api(page, 'GET', `/files/${made.id}/content`)).body;
  const put = await api(page, 'PUT', `/files/${made.id}/content`, { version: cur.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Departures at 8 and 10 from Monday' }] }] } });
  if (put.status !== 200) throw new Error(JSON.stringify(put));
  const fetched = () => page.evaluate((id) => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const t = r.result.transaction('docs', 'readwrite'); const st = t.objectStore('docs'); const g = st.get(id); g.onsuccess = () => { res(g.result?.fetched || 0); r.result.close(); }; }; }), made.id);
  await page.evaluate((id) => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const t = r.result.transaction('docs', 'readwrite'); const st = t.objectStore('docs'); const g = st.get(id); g.onsuccess = () => { st.put({ ...g.result, fetched: 1 }, id); }; t.oncomplete = () => { r.result.close(); res(); }; }; }), made.id);
  await page.reload();
  await until(async () => (await fetched()) > 1, 20000);
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('section.on-this-device').getByRole('link', { name: 'Ferry timetable' }).click({ timeout: 20000 });
  await page.waitForURL(new RegExp(made.id));
  await editor().getByText('Departures at 8 and 10 from Monday').waitFor({ timeout: 20000 }); // never opened here, and up to date
  await ctx.setOffline(false);
  await page.getByText(/You're offline/).first().waitFor({ state: 'detached', timeout: 20000 });
  // And back: no longer kept on purpose.
  await page.goto(`${B}/drive`);
  await row.getByRole('button', { name: 'Actions for Ferry timetable' }).click();
  await page.getByRole('menuitem', { name: 'Don’t keep offline' }).click();
  await page.getByText('is no longer kept available offline').waitFor();
  await row.getByLabel('Available offline').waitFor({ state: 'detached' });
});
await step('Calendar quick add works offline: the event is made when the connection is back', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByLabel('Quick add an event').waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.getByLabel('Quick add an event').fill('Ferry back tomorrow 5pm');
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'New event' });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await page.getByText(/“Ferry back” saved on this device/).waitFor({ timeout: 15000 });
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  const day = new Date(); day.setHours(0, 0, 0, 0);
  await until(async () => ((await api(page, 'GET', `/events?from=${day.getTime()}&to=${day.getTime() + 3 * 864e5}`)).body || []).filter((e) => e.title === 'Ferry back' && new Date(e.start).getHours() === 17).length === 1, 10000);
});
await step('Chat: a conversation last seen here can be read offline, and a message written offline goes when the connection is back', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'trip-plans' })).body.id;
  await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Meet at the harbour at 8' });
  await page.goto(`${B}/chat/${ch}`);
  await page.getByText('Meet at the harbour at 8').waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await page.reload();
  await page.getByText('Meet at the harbour at 8').waitFor({ timeout: 20000 });
  const box = page.getByRole('textbox', { name: 'Message', exact: true });
  await box.click();
  await page.keyboard.type('On my way, no signal');
  await page.keyboard.press('Enter');
  const mine = page.locator('.msg', { hasText: 'On my way, no signal' }).or(page.getByText('On my way, no signal'));
  await mine.first().waitFor();
  await page.getByText('Sends when the connection is back').first().waitFor();
  await page.reload();
  await page.getByText('On my way, no signal').first().waitFor({ timeout: 20000 }); // still there after reloading offline
  await ctx.setOffline(false);
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 30000 });
  await page.getByText('Sends when the connection is back').waitFor({ state: 'detached', timeout: 15000 });
  const r = await api(page, 'GET', `/chat/channels/${ch}/messages`);
  const list = Array.isArray(r.body) ? r.body : r.body.messages;
  if ((list.filter((m) => m.body === 'On my way, no signal').length) !== 1) throw new Error(JSON.stringify(list.map((m) => m.body)));
});
await step('lists and messages kept for offline don’t pile up: the oldest go beyond the limit', async () => {
  const count = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const c = r.result.transaction('api').objectStore('api').count(); c.onsuccess = () => { res(c.result); r.result.close(); }; }; }));
  const before = await count();
  if (before <= 30) throw new Error(`only ${before} kept: nothing to trim`);
  const visit = async () => { for (let i = 0; i < 2; i++) for (const path of ['/calendar', '/tasks', '/contacts', '/notes']) { await page.goto(B + path); await page.waitForTimeout(300); } }; // (each load trims on its first kept answer)
  await page.evaluate(() => localStorage.setItem('nw-api-keep', '5')); // a small limit, to see it work
  await visit();
  const after = await count();
  if (after > 5 + 25) throw new Error(`${before} → ${after}`); // (trimmed on the first kept after a page loads and every 25)
  // While a change waits to be sent, an old list showing it stays (the only place that shows it).
  await page.route('**/api/tasks/tasks/held', (route) => route.abort('internetdisconnected'));
  const me = (await api(page, 'GET', '/auth/me')).body.user.id;
  // (plain functions: the page's content policy allows no code built from text)
  await page.evaluate((user) => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const t = r.result.transaction(['api', 'changes'], 'readwrite'); t.objectStore('api').put({ data: [{ id: 'x', title: 'Not sent', offline: true }], at: 1 }, 'test:holds-unsent'); t.objectStore('changes').put({ method: 'PATCH', url: '/tasks/tasks/held', body: {}, user, label: 'held', at: Date.now() }, '0-held'); t.oncomplete = () => { r.result.close(); res(); }; }; }), me);
  await visit();
  const held = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const g = r.result.transaction('api').objectStore('api').get('test:holds-unsent'); g.onsuccess = () => { res(!!g.result); r.result.close(); }; }; }));
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const t = r.result.transaction(['api', 'changes'], 'readwrite'); t.objectStore('api').delete('test:holds-unsent'); t.objectStore('changes').delete('0-held'); t.oncomplete = () => { r.result.close(); res(); }; }; }));
  await page.unroute('**/api/tasks/tasks/held');
  await page.evaluate(() => localStorage.removeItem('nw-api-keep'));
  if (!held) throw new Error('a list with something not sent yet was trimmed');
});
await step('Chat: a message edited and another deleted offline show so here (even after reloading) and on the server when back', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'ferry-crew' })).body.id;
  const a = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Boat leaves at 9' })).body;
  const b = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Bring snacks maybe' })).body;
  const c = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Tickets bought' })).body;
  await api(page, 'POST', `/chat/messages/${c.id}/reactions`, { emoji: '👍' });
  const msg = (text) => page.locator('.msg', { hasText: text }).last();
  await page.goto(`${B}/chat/${ch}`);
  await msg('Bring snacks maybe').waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  await msg('Boat leaves at 9').hover();
  await msg('Boat leaves at 9').getByRole('button', { name: 'Edit message' }).click();
  await page.getByLabel('Change the message').fill('Boat leaves at 10');
  await page.keyboard.press('Enter');
  await msg('Boat leaves at 10').getByText('Not sent yet').waitFor({ timeout: 15000 });
  await msg('Bring snacks maybe').hover();
  await msg('Bring snacks maybe').getByRole('button', { name: 'Delete message' }).click();
  await page.getByText('Message deleted on this device').waitFor({ timeout: 15000 });
  // A reaction taken back offline (and one added).
  await msg('Tickets bought').getByRole('button', { name: /^👍 1/ }).click();
  await msg('Tickets bought').getByRole('button', { name: /^👍/ }).waitFor({ state: 'detached' });
  await page.reload();
  await msg('Boat leaves at 10').waitFor({ timeout: 20000 });
  if (await msg('Tickets bought').getByRole('button', { name: /^👍/ }).count()) throw new Error('reaction back after reloading');
  if (await page.getByText('Bring snacks maybe').count()) throw new Error('deleted message back after reloading');
  await ctx.setOffline(false);
  await page.getByText('Sent 3 changes made offline').waitFor({ timeout: 30000 });
  const r = await api(page, 'GET', `/chat/channels/${ch}/messages`);
  const list = Array.isArray(r.body) ? r.body : r.body.messages;
  if (list.find((m) => m.id === a.id)?.body !== 'Boat leaves at 10') throw new Error('edit not made');
  const gone = list.find((m) => m.id === b.id);
  if (gone && !gone.deleted_at && gone.body === 'Bring snacks maybe') throw new Error('delete not made');
  if (list.find((m) => m.id === c.id)?.reactions?.length) throw new Error('reaction still there');
});
await step('Chat threads: read offline, and a reply edited and another deleted there are made when back', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'harbour-thread' })).body.id;
  const top = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Who brings the map?' })).body;
  const r1 = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'I will', parent_id: top.id })).body;
  const r2 = (await api(page, 'POST', `/chat/channels/${ch}/messages`, { body: 'Not me', parent_id: top.id })).body;
  const panel = page.getByRole('complementary', { name: 'Thread' });
  const reply = (text) => panel.locator('.msg', { hasText: text }).last();
  const openThread = () => page.locator('.msg', { hasText: 'Who brings the map?' }).getByRole('button', { name: /2 replies/ }).click({ timeout: 20000 });
  await page.goto(`${B}/chat/${ch}`);
  await openThread();
  await reply('Not me').waitFor();
  await page.waitForTimeout(800);
  await ctx.setOffline(true);
  // A link to the message (from search or a notification) opens the conversation as last seen here.
  await page.goto(`${B}/chat/${ch}?msg=${top.id}`).catch(() => {});
  await page.locator('.msg', { hasText: 'Who brings the map?' }).waitFor({ timeout: 20000 });
  if (await page.getByText('isn’t kept on this device').count()) throw new Error('said missing, though it is there');
  await page.goto(`${B}/chat/${ch}?msg=nosuchmessage`).catch(() => {}); // one older than what's kept here
  await page.getByText('That message isn’t kept on this device').waitFor({ timeout: 20000 });
  await page.reload();
  await openThread();
  await reply('Not me').waitFor({ timeout: 20000 }); // the thread, from this device
  await reply('I will').hover();
  await reply('I will').getByRole('button', { name: 'Edit message' }).click();
  await panel.getByLabel('Change the message').fill('I will, the big one');
  await page.keyboard.press('Enter');
  await reply('I will, the big one').getByText('Not sent yet').waitFor({ timeout: 15000 });
  await reply('Not me').hover();
  await reply('Not me').getByRole('button', { name: 'Delete message' }).click();
  await page.getByText('Message deleted on this device').waitFor({ timeout: 15000 });
  // A reply written offline: waits here, and goes when the connection is back.
  await panel.getByRole('textbox', { name: 'Reply', exact: true }).fill('Compass too');
  await page.keyboard.press('Enter');
  await reply('Compass too').getByText('Sends when the connection is back').waitFor({ timeout: 15000 });
  await page.locator('.msg', { hasText: 'Who brings the map?' }).getByRole('button', { name: /2 replies/ }).waitFor(); // one deleted, one added
  await page.reload();
  await page.locator('.msg', { hasText: 'Who brings the map?' }).getByRole('button', { name: /repl/ }).click({ timeout: 20000 });
  await reply('I will, the big one').waitFor({ timeout: 20000 });
  await reply('Compass too').waitFor(); // still waiting after reloading
  if (await panel.getByText('Not me').count()) throw new Error('deleted reply back after reloading');
  await ctx.setOffline(false);
  await page.getByText('Sent 3 changes made offline').waitFor({ timeout: 30000 });
  await panel.getByText('Sends when the connection is back').waitFor({ state: 'detached', timeout: 15000 });
  const t = (await api(page, 'GET', `/chat/messages/${top.id}/replies`)).body;
  if (t.replies.find((m) => m.id === r1.id)?.body !== 'I will, the big one') throw new Error('edit not made');
  const gone = t.replies.find((m) => m.id === r2.id);
  if (gone && !gone.deleted_at && gone.body === 'Not me') throw new Error('delete not made');
  if (t.replies.filter((m) => m.body === 'Compass too').length !== 1) throw new Error('reply not made once');
});
await step('Settings → This device: what is kept here, a warning about what is not sent yet, and removing it all', async () => {
  const me = (await api(page, 'GET', '/auth/me')).body.user.id;
  await page.goto(`${B}/settings`);
  const sec = page.getByRole('region', { name: 'This device' }).or(page.locator('section[aria-labelledby="device-h"]'));
  const kept = sec.getByRole('list', { name: 'Kept on this device' });
  await kept.getByText(/\d+ files? \(the last you opened\)/).waitFor();
  await kept.getByText(/\d+ lists? last seen/).waitFor();
  // Changes made offline and not sent yet (as Tasks and Notes keep them); their server can't be reached for now.
  const away = (route) => route.abort('internetdisconnected');
  await page.route('**/api/tasks/tasks/*', away);
  await page.route('**/api/notes', away);
  const changes = [
    { method: 'POST', url: '/notes', body: { id: 'offShopping0123456789ab', title: 'Shopping' }, label: 'Shopping' },
    { method: 'POST', url: '/notes', body: { id: 'offSettings0123456789ab', title: 'Sent from settings' }, label: 'Sent from settings' },
    { method: 'PATCH', url: '/tasks/tasks/x', body: {}, label: 'x' }, // last: sending stops at the first that can't go (they're made in order)
  ];
  await page.evaluate(([user, list]) => new Promise((res) => { const r = indexedDB.open('nw-offline'); r.onsuccess = () => { const t = r.result.transaction('changes', 'readwrite'); list.forEach((c, i) => t.objectStore('changes').put({ ...c, user, at: Date.now() }, `${Date.now()}-${i}`)); t.oncomplete = () => { r.result.close(); res(); }; }; }), [me, changes]);
  await page.reload();
  await kept.getByText('3 changes waiting to be made').waitFor();
  const waiting = sec.getByRole('list', { name: 'Changes waiting to be made' });
  await waiting.getByText('Change a task: “x”').waitFor();
  await waiting.getByText('Take a note: “Sent from settings”').waitFor();
  await sec.screenshot({ path: `${SP}/shots/device-changes.png` });
  // Discard one: it's never made.
  await waiting.getByRole('button', { name: 'Discard Take a note: “Shopping”' }).click();
  await page.getByRole('dialog', { name: 'Discard this change?' }).getByRole('button', { name: 'Discard' }).click();
  await kept.getByText('2 changes waiting to be made').waitFor();
  // Send now: what can go, goes (the note); the rest waits.
  await page.unroute('**/api/notes', away);
  await sec.getByRole('button', { name: 'Send now' }).click();
  await page.getByText('Sent 1 change made offline').waitFor({ timeout: 20000 });
  await kept.getByText('1 change waiting to be made').waitFor();
  const titles = ((await api(page, 'GET', '/notes')).body || []).map((n) => n.title);
  if (!titles.includes('Sent from settings') || titles.includes('Shopping')) throw new Error(JSON.stringify(titles));
  await sec.getByRole('button', { name: 'Remove everything kept here' }).click();
  const d = page.getByRole('dialog', { name: 'Remove everything kept on this device?' });
  await d.getByText(/Not sent yet, and lost if you remove it: 1 change/).waitFor();
  await d.getByRole('button', { name: 'Remove' }).click();
  await page.getByText('Nothing is kept on this device now').waitFor();
  await kept.getByText('0 files (the last you opened)').waitFor();
  if (await kept.getByText(/change waiting/).count()) throw new Error('the change is still listed');
  await page.unroute('**/api/tasks/tasks/*', away);
  await page.goto(`${B}/docs/${doc.id}`); // something kept again for the steps below
  await editor().waitFor();
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
  await page.getByText('Trip').first().waitFor(); // (its task is done by now, so out of sight)
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
