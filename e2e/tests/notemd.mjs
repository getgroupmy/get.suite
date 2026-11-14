import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
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
await step('download a note as Markdown from its menu', async () => {
  await api(page, 'POST', '/notes', { title: 'Packing', items: [{ text: 'Passport', done: true }, { text: 'Chargers' }] });
  await page.goto(`${B}/notes`);
  const card = page.locator('article.note-card', { hasText: 'Packing' });
  await card.hover();
  await card.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download (.md)' }).click()]);
  if (dl.suggestedFilename() !== 'Packing.md') throw new Error(dl.suggestedFilename());
  const fs = await import('node:fs');
  const text = fs.readFileSync(await dl.path(), 'utf8');
  if (text !== '# Packing\n\n- [x] Passport\n- [ ] Chargers\n') throw new Error(JSON.stringify(text));
  await card.hover();
  await card.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Print' }).waitFor();
});
await step('import .md and .txt files as notes; a downloaded note comes back the same', async () => {
  await page.keyboard.press('Escape');
  await page.getByLabel('Notes to import').setInputFiles([
    { name: 'Groceries.md', mimeType: 'text/markdown', buffer: Buffer.from('# Groceries\n\n- [ ] Milk\n- [x] Eggs\n\n#Home\n') },
    { name: 'Ideas.txt', mimeType: 'text/plain', buffer: Buffer.from('A blog post about tea') },
  ]);
  await page.getByText('2 notes imported').waitFor();
  const g = page.locator('article.note-card', { hasText: 'Groceries' });
  await g.waitFor();
  await g.getByText('Milk').waitFor();
  await g.locator('.note-chip', { hasText: 'Home' }).waitFor();
  await page.locator('article.note-card', { hasText: 'A blog post about tea' }).getByText('Ideas').waitFor();
});
await step('import notes from Google Keep (Takeout .json): colour, pin, checklist, archive; trashed ones left out', async () => {
  const keep = (o) => ({ mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(o)) });
  await page.getByLabel('Notes to import').setInputFiles([
    { name: 'Packing.json', ...keep({ title: 'Packing', listContent: [{ text: 'Passport', isChecked: true }, { text: 'Charger', isChecked: false }], color: 'GREEN', isPinned: true, labels: [{ name: 'Travel' }] }) },
    { name: 'Old.json', ...keep({ title: 'Old plan', textContent: 'From last year', isArchived: true }) },
    { name: 'Binned.json', ...keep({ title: 'Binned', textContent: 'x', isTrashed: true }) },
  ]);
  await page.getByText('2 notes imported (1 empty or deleted skipped)').waitFor();
  const card = page.locator('article.note-card', { hasText: 'Packing' });
  await card.getByText('Charger').first().waitFor();
  await card.locator('.note-chip', { hasText: 'Travel' }).first().waitFor();
  const n = (await api(page, 'GET', '/notes')).body.find((x) => x.title === 'Packing');
  if (n.color !== '#e2f6d3' || !n.pinned) throw new Error(JSON.stringify(n));
  if (await page.locator('article.note-card', { hasText: 'Old plan' }).count()) throw new Error('archived one in the main view');
  if (!(await api(page, 'GET', '/notes?archived=1')).body.some((x) => x.title === 'Old plan')) throw new Error('not in the archive');
  await page.screenshot({ path: `${SP}/shots/notes-keep.png` });
});
await step('import an Evernote export (.enex): its notes, a to-do note as a checklist, tags', async () => {
  const enex = '<?xml version="1.0"?><en-export><note><title>Shopping</title><content><![CDATA[<en-note><div><en-todo checked="true"/>Coffee</div><div><en-todo/>Lemons</div></en-note>]]></content><tag>Errands</tag></note><note><title>Book ideas</title><content><![CDATA[<en-note><div>A novel about lighthouses</div></en-note>]]></content></note></en-export>';
  await page.getByLabel('Notes to import').setInputFiles({ name: 'Evernote.enex', mimeType: 'application/xml', buffer: Buffer.from(enex) });
  await page.getByText('2 notes imported').first().waitFor();
  const card = page.locator('article.note-card', { hasText: 'Shopping' });
  await card.getByText('Lemons').first().waitFor();
  await card.locator('.note-chip', { hasText: 'Errands' }).first().waitFor();
  await page.locator('article.note-card', { hasText: 'A novel about lighthouses' }).first().waitFor();
});
await step('import HTML notes (Apple Notes, OneNote): the title, the text, ticked boxes as a checklist', async () => {
  await page.getByLabel('Notes to import').setInputFiles([
    { name: 'Garden.html', mimeType: 'text/html', buffer: Buffer.from('<html><head><title>Garden plan</title></head><body><h1>Garden plan</h1><p>Tomatoes by the wall</p><ul><li>Order seeds</li></ul></body></html>') },
    { name: 'Packing.html', mimeType: 'text/html', buffer: Buffer.from('<html><body><h2>Packing list</h2><div><input type="checkbox" checked> Tent</div><div><input type="checkbox"> Stove</div></body></html>') },
  ]);
  await page.getByText('2 notes imported').first().waitFor();
  await page.locator('article.note-card', { hasText: 'Garden plan' }).getByText('Tomatoes by the wall').first().waitFor();
  await page.locator('article.note-card', { hasText: 'Packing list' }).getByText('Stove').first().waitFor();
});
await step('import a .zip of notes (as Download (.zip) makes, or Keep’s Takeout)', async () => {
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = new JSZip();
  zip.file('Recipes.md', '# Recipes\n\nSoup: leeks and potatoes\n');
  zip.file('Takeout/Keep/Plants.json', JSON.stringify({ title: 'Plants', textContent: 'Water the fern', isTrashed: false, isArchived: false, isPinned: false, color: 'DEFAULT' }));
  zip.file('Takeout/archive_browser.html', '<html><body>Index</body></html>');
  await page.getByLabel('Notes to import').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await page.getByText('2 notes imported').first().waitFor();
  await page.locator('article.note-card', { hasText: 'Recipes' }).getByText('Soup: leeks and potatoes').first().waitFor();
  await page.locator('article.note-card', { hasText: 'Plants' }).getByText('Water the fern').first().waitFor();
  if (await page.locator('article.note-card', { hasText: 'Index' }).count()) throw new Error('Takeout index imported');
});
await step('a .zip whose note shows a picture from the .zip: the picture comes with the note', async () => {
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const zip = new JSZip();
  zip.file('Garden.md', '# Garden\n\nRoses by the gate\n\n![](Garden%20files/picture-1.png)\n');
  zip.file('Garden files/picture-1.png', png);
  await page.getByLabel('Notes to import').setInputFiles({ name: 'garden.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await page.getByText('1 note imported').first().waitFor();
  const card = page.locator('article.note-card', { hasText: 'Roses by the gate' });
  await card.locator('img').first().waitFor();
  if (await card.getByText('picture-1.png').count()) throw new Error('the picture line stayed in the text');
  const ok = await card.locator('img').first().evaluate((im) => im.complete && im.naturalWidth > 0);
  if (!ok) throw new Error('picture did not load');
});
await step('Keep’s Takeout .zip: a note’s photo comes with it', async () => {
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const zip = new JSZip();
  zip.file('Takeout/Keep/Receipt.json', JSON.stringify({ title: 'Receipt', textContent: 'Lunch with Sam', isTrashed: false, isArchived: false, isPinned: false, color: 'DEFAULT', attachments: [{ filePath: 'r1.png', mimetype: 'image/png' }] }));
  zip.file('Takeout/Keep/r1.png', png);
  await page.getByLabel('Notes to import').setInputFiles({ name: 'takeout-keep.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await page.getByText('1 note imported').first().waitFor();
  const card = page.locator('article.note-card', { hasText: 'Lunch with Sam' });
  await card.locator('img').first().waitFor();
  if (!(await card.locator('img').first().evaluate((im) => im.complete && im.naturalWidth > 0))) throw new Error('photo did not load');
});
await step('an Evernote note’s picture comes in as the note’s picture', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const md5 = (await import('node:crypto')).createHash('md5').update(png).digest('hex');
  const enex = `<?xml version="1.0"?><en-export><note><title>Whiteboard photo</title><content><![CDATA[<en-note><div>Sprint plan</div><en-media type="image/png" hash="${md5}"/></en-note>]]></content><resource><data encoding="base64">${png.toString('base64')}</data><mime>image/png</mime></resource></note></en-export>`;
  await page.getByLabel('Notes to import').setInputFiles({ name: 'Photos.enex', mimeType: 'application/xml', buffer: Buffer.from(enex) });
  await page.getByText('1 note imported').first().waitFor();
  const card = page.locator('article.note-card', { hasText: 'Sprint plan' });
  await card.locator('img').first().waitFor();
  if (await card.getByText('[attachment]').count()) throw new Error('still marked as an attachment');
  if (!(await card.locator('img').first().evaluate((im) => im.complete && im.naturalWidth > 0))) throw new Error('picture did not load');
});
await step('an HTML note with a picture written into the page keeps the picture', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const html = `<html><head><title>Floor plan</title></head><body><p>Desk by the window</p><img src="data:image/png;base64,${png.toString('base64')}"></body></html>`;
  await page.getByLabel('Notes to import').setInputFiles({ name: 'Floor plan.html', mimeType: 'text/html', buffer: Buffer.from(html) });
  await page.getByText('1 note imported').first().waitFor();
  const card = page.locator('article.note-card', { hasText: 'Desk by the window' });
  await card.locator('img').first().waitFor();
  if (await card.getByText('[picture]').count()) throw new Error('still marked');
  if (!(await card.locator('img').first().evaluate((im) => im.complete && im.naturalWidth > 0))) throw new Error('picture did not load');
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
