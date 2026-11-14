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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
let docId, kim, vic;
const content = () => api(page, 'GET', `/files/${docId}/content`).then((r) => r.body.content);

await step('setup: a document shared with an editor and a viewer', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  for (const [local, name] of [['kim', 'Kim Park'], ['vic', 'Vic Viewer']]) await api(page, 'POST', '/users', { local, domain: 'acme.com', name, password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  const idOf = (e) => dir.find((u) => u.username === e).id;
  docId = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Report', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Costs are rising' }] }] } })).body.id;
  await api(page, 'PUT', `/files/${docId}/shares`, { shares: [{ user_id: idOf('kim@acme.com'), role: 'editor' }, { user_id: idOf('vic@acme.com'), role: 'viewer' }] });
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  vic = await mk('vic'); await signIn(vic, 'vic@acme.com');
  for (const p of [page, kim, vic]) { await p.goto(`${B}/docs/${docId}`); await p.getByText('Costs are rising').waitFor(); }
});

// Select a word in the document, as a person dragging over it would (the editor's own positions:
// the others' cursors sit inside the text, so arrow keys and DOM text nodes are unreliable).
const selectWord = (p, word) => p.evaluate((w) => {
  const ed = document.querySelector('.paper .tiptap').editor;
  let at = null;
  ed.state.doc.descendants((n, pos) => { if (at === null && n.isText) { const i = n.text.indexOf(w); if (i >= 0) at = pos + i; } });
  if (at === null) throw new Error(`no "${w}" in the document`);
  ed.chain().focus().setTextSelection({ from: at, to: at + w.length }).run();
}, word);

const cursorAfter = (p, word) => p.evaluate((w) => {
  const ed = document.querySelector('.paper .tiptap').editor;
  let at = null;
  ed.state.doc.descendants((n, pos) => { if (at === null && n.isText) { const i = n.text.indexOf(w); if (i >= 0) at = pos + i + w.length; } });
  if (at === null) throw new Error(`no "${w}" in the document`);
  ed.chain().focus().setTextSelection(at).run();
}, word);

// Is there text `word` shown with this computed style?
const styled = (p, word, prop, value) => p.evaluate(([w, k, v]) => [...document.querySelectorAll('.paper .tiptap span')].some((el) => el.textContent === w && getComputedStyle(el)[k] === v), [word, prop, value]);

await step('text colour and highlight', async () => {
  await page.locator('.paper .tiptap').click();
  await selectWord(page, 'rising');
  await page.getByLabel('Text colour').selectOption({ label: 'Red' });
  await until(() => styled(kim, 'rising', 'color', 'rgb(197, 34, 31)'));
  await selectWord(page, 'Costs');
  await page.getByLabel('Highlight').selectOption({ label: 'Yellow' });
  await until(() => styled(kim, 'Costs', 'backgroundColor', 'rgb(253, 226, 147)'));
});

await step('a table: insert, type in cells, add a row; the others see it', async () => {
  await cursorAfter(page, 'rising');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert table (3 × 3)' }).click();
  await page.keyboard.type('Item'); await page.keyboard.press('Tab'); await page.keyboard.type('Cost'); await page.keyboard.press('Tab'); await page.keyboard.type('Note');
  await page.keyboard.press('Tab'); await page.keyboard.type('Paper'); await page.keyboard.press('Tab'); await page.keyboard.type('12');
  await kim.locator('.paper table th', { hasText: 'Cost' }).waitFor();
  await kim.locator('.paper table td', { hasText: 'Paper' }).waitFor();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add row below' }).click();
  await until(async () => (await kim.locator('.paper table tr').count()) === 4);
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete column' }).click();
  await until(async () => (await kim.locator('.paper table tr').first().locator('th').count()) === 2);
});

await step('a picture: put in from a file, made smaller and centred; a viewer sees it', async () => {
  await cursorAfter(page, 'rising');
  await page.keyboard.press('Enter');
  await page.locator('.toolbar input[type=file]').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
  const img = page.locator('.paper img[data-file]');
  await img.waitFor();
  await until(() => img.evaluate((el) => el.complete && el.naturalWidth === 64));
  await img.click();
  await page.getByLabel('Picture size').selectOption({ label: 'Medium' });
  await page.getByRole('button', { name: 'Picture in the centre' }).click();
  const vimg = vic.locator('.paper img[data-file]');
  await vimg.waitFor();
  await until(async () => { await vic.reload(); await vic.locator('.paper img[data-file]').waitFor(); return vic.locator('.paper img[data-file]').evaluate((el) => el.complete && el.naturalWidth === 64 && el.dataset.width === '50%' && el.dataset.align === 'center'); }, 15000);
  await page.screenshot({ path: `${SP}/shots/docrich.png` });
});

await step('saved, and downloaded as Word with the table and the picture', async () => {
  await until(async () => { const c = JSON.stringify(await content()); return c.includes('"type":"table"') && c.includes('"type":"image"') && c.includes('#c5221f'); }, 10000).catch(async (e) => { console.log('DBG', JSON.stringify(await content())); throw e; });
  const word = await page.evaluate(async (id) => { const r = await fetch(`/api/files/${id}/export`); const b = new Uint8Array(await r.arrayBuffer()); return { status: r.status, size: b.length, text: new TextDecoder('latin1').decode(b) }; }, docId);
  if (word.status !== 200 || !word.text.includes('word/media/')) throw new Error('no picture in the Word file');
});

await step('viewers have no toolbar', async () => {
  if (await vic.getByRole('button', { name: 'Insert picture' }).count()) throw new Error('viewer toolbar');
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
