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
const notes = async (qs = '') => Object.fromEntries((await api(page, 'GET', `/notes${qs}`)).body.map((n) => [n.title, n]));
await step('setup: some notes', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const t of ['Groceries', 'Ideas', 'Trip', 'Old stuff']) await api(page, 'POST', '/notes', { title: t, body: `${t} text` });
  await page.goto(`${B}/notes`);
  await page.getByRole('heading', { name: 'Old stuff' }).waitFor();
});
await step('Pick notes with ✓; clicking a card then picks it too', async () => {
  await page.getByRole('article', { name: 'Ideas' }).hover();
  await page.getByRole('button', { name: 'Select note: Ideas' }).click();
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  await bar.getByText('1 selected').waitFor();
  await page.getByRole('article', { name: 'Trip' }).locator('.note-open').click(); // picks, doesn't open
  await bar.getByText('2 selected').waitFor();
  if (await page.getByRole('dialog').count()) throw new Error('opened a note');
  await page.screenshot({ path: `${SP}/shots/notebatch.png` });
});
await step('Download (.zip): the picked notes as Markdown files', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  const [dl] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download (.zip)' }).click()]);
  if (dl.suggestedFilename() !== 'Notes (2).zip') throw new Error(dl.suggestedFilename());
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(await dl.path()));
  const names = Object.keys(zip.files).sort().join(' | ');
  if (names !== 'Ideas.md | Trip.md') throw new Error(names);
  if (!/Ideas text/.test(await zip.file('Ideas.md').async('string'))) throw new Error('no text');
  await bar.getByText('2 selected').waitFor(); // still picked
});
await step('Print: the picked notes on one printout, each on its own page', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  await bar.getByRole('button', { name: 'Print' }).click();
  const frame = page.locator('iframe.print-frame').last();
  await frame.waitFor({ state: 'attached' });
  const html = await frame.getAttribute('srcdoc');
  if ((html.match(/<section class="note">/g) || []).length !== 2 || !/Ideas text/.test(html) || !/Trip text/.test(html) || /Groceries/.test(html)) throw new Error(html.slice(0, 300));
});
await step('Send in Chat…: links to the picked notes wait in the channel’s message box', async () => {
  const ch = (await api(page, 'POST', '/chat/channels', { name: 'notes-room' })).body.id;
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  await bar.getByRole('button', { name: 'Send in Chat…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Send 2 notes in Chat' });
  await dlg.getByLabel('Conversation').selectOption({ label: '# notes-room' });
  await dlg.getByRole('button', { name: 'Open in Chat' }).click();
  await page.waitForURL(new RegExp(`/chat/${ch}`));
  await page.waitForFunction(() => { const v = document.querySelector('textarea[aria-label="Message"]')?.value || ''; return /Ideas: .*\/notes\?note=/.test(v) && /Trip: .*\/notes\?note=/.test(v); });
  await page.goto(`${B}/notes`);
  await page.getByRole('heading', { name: 'Ideas' }).waitFor();
  await page.getByRole('article', { name: 'Ideas' }).hover();
  await page.getByRole('button', { name: 'Select note: Ideas' }).click();
  await page.getByRole('article', { name: 'Trip' }).locator('.note-open').click();
  await bar.getByText('2 selected').waitFor();
});
await step('Pin, colour and label them together', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  await bar.getByRole('button', { name: '📌 Pin' }).click();
  await page.locator('.toast', { hasText: '2 notes pinned' }).last().waitFor();
  let n = await notes();
  if (!n.Ideas.pinned || !n.Trip.pinned || n.Groceries.pinned) throw new Error('pins');
  await page.getByRole('heading', { name: 'Pinned' }).waitFor();
  for (const t of ['Ideas', 'Trip']) await page.getByRole('button', { name: `Select note: ${t}` }).click({ force: true });
  await bar.getByLabel('Colour for the selected notes').selectOption({ label: 'Mint' });
  await page.locator('.toast', { hasText: '2 notes coloured' }).last().waitFor();
  for (const t of ['Ideas', 'Groceries']) await page.getByRole('button', { name: `Select note: ${t}` }).click({ force: true });
  await bar.getByLabel('Label the selected notes').selectOption({ label: 'New label…' });
  const dlg = page.getByRole('dialog', { name: 'New label' });
  await dlg.getByLabel('Label').fill('Work');
  await dlg.getByRole('button', { name: 'Add' }).click();
  await page.locator('.toast', { hasText: '2 notes labelled Work' }).last().waitFor();
  n = await notes();
  if (n.Ideas.color !== '#e2f6d3' || n.Trip.color !== '#e2f6d3' || n.Ideas.labels.join() !== 'Work' || n.Groceries.labels.join() !== 'Work' || n.Trip.labels.length) throw new Error(JSON.stringify(n));
});
await step('Remove label…: offers the labels the picked notes have, and takes one off them all', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  for (const t of ['Trip']) await page.getByRole('button', { name: `Select note: ${t}` }).click({ force: true });
  if (await bar.getByLabel('Take a label off the selected notes').count()) throw new Error('offered for a note without labels');
  for (const t of ['Ideas', 'Groceries']) await page.getByRole('button', { name: `Select note: ${t}` }).click({ force: true });
  const opts = await bar.getByLabel('Take a label off the selected notes').locator('option').allTextContents();
  if (opts.join('|') !== 'Remove label…|Work') throw new Error(opts.join('|'));
  await bar.getByLabel('Take a label off the selected notes').selectOption({ label: 'Work' });
  await page.locator('.toast', { hasText: 'Work taken off 3 notes' }).last().waitFor();
  const n = await notes();
  if (n.Ideas.labels.length || n.Groceries.labels.length || n.Trip.labels.length) throw new Error(JSON.stringify(n));
  // Put back for the steps after.
  await api(page, 'POST', '/notes/batch', { ids: [n.Ideas.id, n.Groceries.id], change: { label: 'Work' } });
  await page.reload();
  await page.getByRole('button', { name: 'Select note: Ideas' }).waitFor();
});
await step('Share…: the picked notes shared with more colleagues at once', async () => {
  const sam = (await api(page, 'POST', '/users', { local: 'sam', domain: 'acme.com', name: 'Sam Shared', password: 'password123' })).body;
  if (!sam?.id) throw new Error(JSON.stringify(sam));
  await page.reload();
  await page.getByRole('button', { name: 'Select note: Ideas' }).waitFor();
  for (const t of ['Ideas', 'Groceries']) await page.getByRole('button', { name: `Select note: ${t}` }).click({ force: true });
  await page.getByRole('toolbar', { name: 'Change the selected notes' }).getByRole('button', { name: 'Share…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Share 2 notes' });
  if (!(await dlg.getByRole('button', { name: 'Share', exact: true }).isDisabled())) throw new Error('nobody ticked yet');
  await dlg.getByLabel('Sam Shared').check();
  await dlg.getByRole('button', { name: 'Share', exact: true }).click();
  await page.locator('.toast', { hasText: 'Shared: 2 new shares' }).last().waitFor();
  const n = await notes();
  if (n.Ideas.shared.map((u) => u.name).join() !== 'Sam Shared' || n.Groceries.shared.map((u) => u.name).join() !== 'Sam Shared' || n.Trip.shared.length) throw new Error(JSON.stringify(n));
  for (const id of [n.Ideas.id, n.Groceries.id]) await api(page, 'PUT', `/notes/${id}/shares`, { user_ids: [] }); // as before, for the steps after
  await page.reload();
  await page.getByRole('button', { name: 'Select note: Ideas' }).waitFor();
});
await step('Make copies: a copy of each picked note, at the top', async () => {
  const before = (await api(page, 'GET', '/notes')).body.length;
  for (const t of ['Trip', 'Groceries']) await page.getByRole('button', { name: `Select note: ${t}` }).click({ force: true });
  await page.getByRole('toolbar', { name: 'Change the selected notes' }).getByRole('button', { name: 'Make copies' }).click();
  await page.locator('.toast', { hasText: '2 copies made' }).last().waitFor();
  const all = (await api(page, 'GET', '/notes')).body;
  if (all.length !== before + 2) throw new Error(`${before} → ${all.length}`);
  const copies = all.filter((n) => ['Trip', 'Groceries'].includes(n.title));
  if (copies.length !== 4 || copies.some((n) => !n.mine)) throw new Error(JSON.stringify(copies.map((n) => n.title)));
  await until(async () => (await page.getByRole('button', { name: 'Select note: Trip' }).count()) === 2);
  // Take the copies away again for the steps after (the newest two).
  const newest = all.filter((n) => ['Trip', 'Groceries'].includes(n.title) && !n.pinned).sort((x, y) => y.created_at - x.created_at).slice(0, 2);
  for (const n of newest) await api(page, 'DELETE', `/notes/${n.id}`);
  await page.reload();
  await page.getByRole('button', { name: 'Select note: Ideas' }).waitFor();
});
await step('a printed note shows its pictures', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const ideas = (await api(page, 'GET', '/notes')).body.find((n) => n.title === 'Ideas');
  await page.evaluate(async ([id, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await fetch(`/api/notes/${id}/pictures`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'image/png' }, body: bytes });
  }, [ideas.id, png]);
  await page.reload();
  await page.getByRole('heading', { name: 'Ideas' }).waitFor();
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  await page.getByRole('article', { name: 'Ideas' }).hover();
  await page.getByRole('button', { name: 'Select note: Ideas' }).click();
  await bar.getByRole('button', { name: 'Print' }).click();
  const frame = page.frameLocator('iframe.print-frame').last();
  await frame.locator('img').first().waitFor({ state: 'attached' });
  const ok = await page.locator('iframe.print-frame').last().evaluate((f) => { const im = f.contentDocument.querySelector('img'); return im && im.complete && im.naturalWidth > 0; });
  if (!ok) throw new Error('the picture did not load in the printout');
  await bar.getByRole('button', { name: 'Clear' }).click();
});
await step('Archive and delete several', async () => {
  const bar = page.getByRole('toolbar', { name: 'Change the selected notes' });
  for (const t of ['Old stuff', 'Groceries']) await page.getByRole('button', { name: `Select note: ${t}` }).click({ force: true });
  await bar.getByRole('button', { name: 'Archive' }).click();
  await page.locator('.toast', { hasText: '2 notes archived' }).last().waitFor();
  await page.getByRole('heading', { name: 'Old stuff' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Select note: Trip' }).click({ force: true });
  await bar.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.toast', { hasText: '1 note moved to the trash' }).last().waitFor();
  const left = Object.keys(await notes()).sort().join();
  if (left !== 'Ideas') throw new Error(left);
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
