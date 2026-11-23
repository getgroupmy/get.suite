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
let kim;
const titles = (p = page, label = 'Tasks') => p.getByRole('list', { name: label, exact: true }).locator('.task-title').allInnerTexts();
const task = (p, t) => p.locator('.task', { has: p.locator('.task-title', { hasText: new RegExp(`^${t}$`) }) });
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
await step('setup: a colleague', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
});
let doc, pdf;
await step('the owner turns off downloading, printing and copying for viewers, in Share', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Board strategy' })).body;
  pdf = await page.evaluate(async () => (await (await fetch('/api/files/upload?name=board-pack.pdf', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: '%PDF-1.4 x' })).json()));
  for (const f of [doc, pdf]) await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Share' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Viewers and commenters can download, print and copy').uncheck();
  await page.getByText('Viewers and commenters can only look at it now').waitFor();
  await api(page, 'PATCH', `/files/${pdf.id}`, { no_download: true });
});
await step('Kim, a viewer, can read it but isn\'t offered downloading, printing or a copy', async () => {
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByRole('note').getByText('View only: the owner has turned off downloading, printing and copying.').waitFor();
  await kim.getByRole('button', { name: 'More' }).click();
  await kim.getByRole('menuitem').first().waitFor();
  const labels = await kim.getByRole('menuitem').allInnerTexts();
  if (labels.some((l) => /Download|Print/.test(l))) throw new Error(labels.join(' | '));
  await kim.keyboard.press('Escape');
  const r = await api(kim, 'GET', `/files/${doc.id}/export?format=docx`);
  if (r.status !== 403) throw new Error('export ' + r.status);
  await kim.goto(`${B}/drive/shared`);
  const row = kim.locator('tr', { hasText: 'board-pack.pdf' });
  await row.waitFor();
  await row.getByRole('button').last().click();
  await kim.getByRole('menuitem', { name: 'Open' }).first().waitFor();
  if (await kim.getByRole('menuitem', { name: 'Download' }).count()) throw new Error('Download offered');
  if (await kim.getByRole('menuitem', { name: 'Make a copy' }).count()) throw new Error('copy offered');
}, kim);
await step('Kim makes a copy of a document with Olivia\'s picture in it: the picture shows in Kim\'s copy', async () => {
  const pic = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 48; c.height = 24; const g = c.getContext('2d'); g.fillStyle = '#43a047'; g.fillRect(0, 0, 48, 24);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    return (await fetch('/api/files/upload?name=green.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: blob })).json();
  });
  const memo = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Pictured memo', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See the chart' }] }, { type: 'image', attrs: { fileId: pic.id, alt: 'Green chart' } }] } })).body;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${memo.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await kim.goto(`${B}/drive/shared`);
  const row = kim.locator('tr', { hasText: 'Pictured memo' });
  await row.waitFor();
  await row.getByRole('button').last().click();
  await kim.getByRole('menuitem', { name: 'Make a copy' }).click();
  const copy = await until(async () => (await api(kim, 'GET', '/files')).body.find((f) => /Pictured memo/.test(f.name)));
  await kim.goto(`${B}/docs/${copy.id}`);
  await kim.locator('.ProseMirror').getByText('See the chart').waitFor();
  await until(() => kim.locator('.ProseMirror img[alt="Green chart"]').evaluate((i) => i.complete && i.naturalWidth === 48).catch(() => false), 10000);
}, kim);
await step('Olivia takes Kim off a document Kim added a picture to: it still shows there', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  const plan = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Team plan' })).body;
  await api(page, 'PUT', `/files/${plan.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  const pic = await kim.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 56; c.height = 28; const g = c.getContext('2d'); g.fillStyle = '#00897b'; g.fillRect(0, 0, 56, 28);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    return (await fetch('/api/files/upload?name=teal.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: blob })).json();
  });
  const cur = (await api(kim, 'GET', `/files/${plan.id}/content`)).body;
  await api(kim, 'PUT', `/files/${plan.id}/content`, { version: cur.file.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Our plan' }] }, { type: 'image', attrs: { fileId: pic.id, alt: 'Teal map' } }] } });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Team plan' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const d = page.getByRole('dialog', { name: /Share “Team plan”/ });
  await d.getByRole('button', { name: 'Remove Kim Park' }).click();
  await d.getByRole('button', { name: 'Save' }).click();
  await d.waitFor({ state: 'detached' });
  await page.goto(`${B}/docs/${plan.id}`);
  await page.locator('.ProseMirror').getByText('Our plan').waitFor();
  await until(() => page.locator('.ProseMirror img[alt="Teal map"]').evaluate((i) => i.complete && i.naturalWidth === 56).catch(() => false), 10000);
});
await step('⋮ → Make a copy…: named, shared with the same people, with its comments; the copy opens, and Kim can edit it', async () => {
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  const orig = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] }] } })).body;
  await api(page, 'PUT', `/files/${orig.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await api(page, 'POST', `/comments/${orig.id}`, { body: 'Check the date', anchor: { quote: 'Step one' } });
  await page.goto(`${B}/docs/${orig.id}`);
  await page.locator('.ProseMirror').getByText('Step one').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Make a copy…' }).click();
  const d = page.getByRole('dialog', { name: 'Make a copy' });
  await d.getByLabel('Name').fill('Launch plan B');
  await d.getByLabel('Share it with the same people').check();
  await d.getByRole('checkbox', { name: /Copy comments/ }).check();
  await d.getByRole('button', { name: 'Make a copy' }).click();
  await page.waitForURL((u) => /\/docs\//.test(u.pathname) && !u.pathname.endsWith(orig.id));
  await page.locator('.ProseMirror').getByText('Step one').waitFor();
  const id = new URL(page.url()).pathname.split('/').pop();
  const f = (await api(kim, 'GET', `/files/${id}`)).body;
  if (f.name !== 'Launch plan B' || f.role !== 'editor') throw new Error(JSON.stringify(f));
  const cs = (await api(page, 'GET', `/comments/${id}`)).body;
  if (cs.length !== 1 || cs[0].body !== 'Check the date') throw new Error('comments: ' + JSON.stringify(cs));
});
await step('Make a copy… into a folder of your choosing', async () => {
  const folder = (await api(page, 'POST', '/files/folder', { name: 'Copies kept' })).body;
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Memo to file', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').getByText('Keep this').waitFor();
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Make a copy…' }).click();
  const d = page.getByRole('dialog', { name: 'Make a copy' });
  await d.getByRole('group', { name: 'Folder' }).getByText('Next to this one').waitFor();
  await d.getByRole('button', { name: 'Change…' }).click();
  // The same chooser as Drive's Move to…
  const w = page.getByRole('dialog', { name: 'Where should the copy go?' });
  await w.locator('.pick-list').getByRole('button', { name: /Copies kept/ }).click();
  await w.getByRole('button', { name: 'Copies kept' }).waitFor(); // (in the path now)
  await w.getByRole('button', { name: 'Put it here' }).click();
  await w.waitFor({ state: 'detached' });
  await d.getByRole('group', { name: 'Folder' }).getByText('Copies kept').waitFor();
  await d.getByRole('button', { name: 'Make a copy' }).click();
  await page.waitForURL((u) => /\/docs\//.test(u.pathname) && !u.pathname.endsWith(doc.id));
  const id = new URL(page.url()).pathname.split('/').pop();
  const f = (await api(page, 'GET', `/files/${id}`)).body;
  if (f.parent_id !== folder.id || f.name !== 'Copy of Memo to file') throw new Error(JSON.stringify([f.parent_id, f.name]));
});
await step('Make a copy…: the folder copied to last is under Recent, a folder deep down is found by name, and Esc closes only the chooser', async () => {
  const records = (await api(page, 'POST', '/files/folder', { name: 'Records' })).body;
  const deep = (await api(page, 'POST', '/files/folder', { name: 'Archive 2026', parent_id: records.id })).body;
  const book = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget book', content: { sheets: [{ name: 'One', cells: { A1: '5' } }] } })).body;
  await page.goto(`${B}/sheets/${book.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Make a copy…' }).click();
  const d = page.getByRole('dialog', { name: 'Make a copy' });
  await d.getByRole('button', { name: 'Change…' }).click();
  const w = page.getByRole('dialog', { name: 'Where should the copy go?' });
  await w.getByRole('list', { name: 'Recent folders' }).getByRole('button', { name: /Copies kept/ }).waitFor();
  await page.keyboard.press('Escape');
  await w.waitFor({ state: 'detached' });
  await d.getByRole('group', { name: 'Folder' }).getByText('Next to this one').waitFor(); // still open, unchanged
  await d.getByRole('button', { name: 'Change…' }).click();
  await w.getByLabel('Find a folder').fill('archive 20');
  await w.getByRole('list', { name: 'Folders found' }).getByRole('button', { name: /Archive 2026.*in Records/ }).click();
  await w.getByRole('button', { name: 'Put it here' }).click();
  await d.getByRole('group', { name: 'Folder' }).getByText('Archive 2026').waitFor();
  await d.getByRole('button', { name: 'Make a copy' }).click();
  await page.waitForURL((u) => /\/sheets\//.test(u.pathname) && !u.pathname.endsWith(book.id));
  const f = (await api(page, 'GET', `/files/${new URL(page.url()).pathname.split('/').pop()}`)).body;
  if (f.parent_id !== deep.id || f.name !== 'Copy of Budget book') throw new Error(JSON.stringify([f.parent_id, f.name]));
  const recent = (await api(page, 'GET', '/files/recent-destinations')).body.map((x) => x.name);
  if (recent[0] !== 'Archive 2026' || recent[1] !== 'Copies kept') throw new Error('recent: ' + recent);
});
await step('Make a copy…: + New folder in the chooser makes one and puts the copy in it', async () => {
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Pitch deck', content: { slides: [{ id: 's1', items: [] }] } })).body;
  await page.goto(`${B}/slides/${deck.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Make a copy…' }).click();
  const d = page.getByRole('dialog', { name: 'Make a copy' });
  await d.getByLabel('Name').fill('Pitch for Globex');
  await d.getByRole('button', { name: 'Change…' }).click();
  const w = page.getByRole('dialog', { name: 'Where should the copy go?' });
  await w.getByRole('button', { name: '+ New folder' }).click();
  const n = page.getByRole('dialog', { name: 'New folder' });
  await n.getByLabel('Folder name').fill('Globex pitches');
  await n.getByRole('button', { name: 'Create' }).click();
  await w.getByRole('button', { name: 'Globex pitches' }).waitFor();
  await w.getByRole('button', { name: 'Put it here' }).click();
  await d.getByRole('group', { name: 'Folder' }).getByText('Globex pitches').waitFor();
  await d.getByRole('button', { name: 'Make a copy' }).click();
  await page.waitForURL((u) => /\/slides\//.test(u.pathname) && !u.pathname.endsWith(deck.id));
  const f = (await api(page, 'GET', `/files/${new URL(page.url()).pathname.split('/').pop()}`)).body;
  const folder = (await api(page, 'GET', `/files/${f.parent_id}`)).body;
  if (folder.name !== 'Globex pitches' || f.name !== 'Pitch for Globex') throw new Error(JSON.stringify([folder.name, f.name]));
});
await step('Kim, a viewer, can copy a link to a slide, a sheet and a cell (and nothing else in those menus)', async () => {
  await kim.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  const deck = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Read-only deck', content: { slides: [{ id: 'r1', items: [] }, { id: 'r2', items: [] }] } })).body;
  const book = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Read-only book', content: { sheets: [{ name: 'One', cells: {} }, { name: 'Two', cells: { A1: 'x' } }] } })).body;
  for (const f of [deck, book]) await api(page, 'PUT', `/files/${f.id}/shares`, { shares: [{ user_id: kimId, role: 'viewer' }] });
  await kim.goto(`${B}/slides/${deck.id}`);
  await kim.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await kim.getByRole('button', { name: 'Options for slide 2' }).click();
  const items = await kim.getByRole('menuitem').allInnerTexts();
  if (items.map((t) => t.trim()).join('|') !== 'Copy link to slide') throw new Error(items.join('|'));
  await kim.getByRole('menuitem', { name: 'Copy link to slide' }).click();
  await until(async () => (await kim.evaluate(() => navigator.clipboard.readText())) === `${B}/slides/${deck.id}#slide=r2`);
  await kim.goto(`${B}/sheets/${book.id}`);
  await kim.locator('.sheet-tab > button:first-child', { hasText: /^Two$/ }).click();
  await kim.getByRole('button', { name: 'Options for Two' }).click();
  await kim.getByRole('menuitem', { name: 'Copy link to sheet' }).click();
  await until(async () => (await kim.evaluate(() => navigator.clipboard.readText())) === `${B}/sheets/${book.id}#sheet=Two`);
  // Right-click a cell: only its link
  await kim.locator('[data-k="A1"]').click({ button: 'right' });
  const cellItems = await kim.getByRole('menu', { name: 'Cell actions' }).getByRole('menuitem').allInnerTexts();
  if (cellItems.map((t) => t.trim()).join('|') !== 'Copy link to this cell') throw new Error(cellItems.join('|'));
  await kim.getByRole('menuitem', { name: 'Copy link to this cell' }).click();
  await until(async () => (await kim.evaluate(() => navigator.clipboard.readText())) === `${B}/sheets/${book.id}#sheet=Two&range=A1`);
}, kim);
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
