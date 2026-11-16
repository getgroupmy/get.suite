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
  await until(async () => ((await api(page, 'GET', `/events?from=${day.getTime()}&to=${day.getTime() + 864e5}`)).body || []).filter((e) => e.title === 'Ferry to the island').length === 1, 10000);
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
