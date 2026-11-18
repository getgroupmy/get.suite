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

await step('a cell colour from the toolbar: the others see it; Word and .odt downloads keep it', async () => {
  if (await page.getByLabel('Cell colour').count()) { await page.getByText('Costs are rising').click(); }
  await page.locator('.paper table td', { hasText: 'Paper' }).click();
  const pick = page.getByLabel('Cell colour');
  await pick.selectOption({ label: '▦ Light yellow' });
  const bg = (p) => p.locator('.paper table td', { hasText: 'Paper' }).evaluate((el) => getComputedStyle(el).backgroundColor);
  await until(async () => (await bg(page)) === 'rgb(254, 247, 224)');
  await until(async () => (await bg(kim)) === 'rgb(254, 247, 224)');
  if ((await pick.inputValue()) !== '#fef7e0') throw new Error('the menu shows the cell’s colour');
  // Outside a table there's no cell colour to pick.
  await page.getByText('Costs are rising').click();
  await until(async () => (await page.getByLabel('Cell colour').count()) === 0);
  await page.screenshot({ path: `${SP}/shots/cell-colour.png` });
  await page.waitForTimeout(2500); // saved
  for (const format of ['docx', 'odt']) {
    const up = await page.evaluate(async ([id, f]) => {
      const bytes = await (await fetch(`/api/files/${id}/export?format=${f}`)).arrayBuffer();
      return (await fetch(`/api/files/upload?name=Report%20copy.${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    }, [docId, format]);
    const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
    if (opened.status >= 300) throw new Error(JSON.stringify(opened));
    const table = (await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content.content.find((n) => n.type === 'table');
    const cells = table.content.map((r) => r.content.map((c) => `${c.type === 'tableHeader' ? 'H' : ''}${c.attrs?.background || '-'}`).join(' ')).join(' | ');
    if (cells !== 'H- H- | #fef7e0 - | - - | - -') throw new Error(`${format}: ${cells}`);
  }
});
await step('drag a column’s edge to make it wider: the others see it; Word and .odt downloads keep the widths', async () => {
  const th = page.locator('.paper table th').first();
  const before = await th.evaluate((el) => el.getBoundingClientRect().width);
  const box = await th.boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.move(box.x + box.width + 150, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await th.evaluate((el) => el.getBoundingClientRect().width);
  if (after < before + 100) throw new Error(`${before} → ${after}`);
  await until(async () => (await kim.locator('.paper table th').first().evaluate((el) => el.getBoundingClientRect().width)) > before + 100);
  await page.screenshot({ path: `${SP}/shots/column-width.png` });
  await page.waitForTimeout(2500); // saved
  const widths = (d) => d.content.find((n) => n.type === 'table').content[0].content.map((c) => (c.attrs?.colwidth || []).join('+') || '-').join(' ');
  const saved = widths((await api(page, 'GET', `/files/${docId}/content`)).body.content);
  if (!/^\d+ -$/.test(saved)) throw new Error(`saved ${saved}`); // the column dragged; the other takes what's left
  const want = [Number(saved.split(' ')[0]), 624 - Number(saved.split(' ')[0])]; // (the page's width between its margins)
  for (const format of ['docx', 'odt']) {
    const up = await page.evaluate(async ([id, f]) => {
      const bytes = await (await fetch(`/api/files/${id}/export?format=${f}`)).arrayBuffer();
      return (await fetch(`/api/files/upload?name=Report%20widths.${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    }, [docId, format]);
    const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
    const back = widths((await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content);
    // (back within a pixel or so: twips and centimetres are rounded)
    const b = back.split(' ').map(Number);
    if (b.length !== 2 || b.some((w, i) => Math.abs(w - want[i]) > 2)) throw new Error(`${format}: ${saved} → ${back}`);
  }
});
await step('merge two cells and unmerge them; the others see it; Word and .odt keep merged cells', async () => {
  const lastRow = (p) => p.locator('.paper table tr').last();
  await lastRow(page).locator('td').first().click();
  await lastRow(page).locator('td').last().click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Merge cells', exact: true }).click();
  await until(async () => (await lastRow(page).locator('td').count()) === 1 && (await lastRow(page).locator('td').getAttribute('colspan')) === '2');
  await until(async () => (await lastRow(kim).locator('td').count()) === 1);
  await page.keyboard.type('Total');
  await page.waitForTimeout(2500); // saved
  const merged = (d) => d.content.find((n) => n.type === 'table').content.at(-1).content.map((c) => `${c.attrs?.colspan || 1}:${c.content?.[0]?.content?.[0]?.text || ''}`).join(' ');
  if (merged((await api(page, 'GET', `/files/${docId}/content`)).body.content) !== '2:Total') throw new Error('not saved merged');
  for (const format of ['docx', 'odt']) {
    const up = await page.evaluate(async ([id, f]) => {
      const bytes = await (await fetch(`/api/files/${id}/export?format=${f}`)).arrayBuffer();
      return (await fetch(`/api/files/upload?name=Report%20merged.${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
    }, [docId, format]);
    const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
    const back = merged((await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content);
    if (back !== '2:Total') throw new Error(`${format}: ${back}`);
  }
  await page.screenshot({ path: `${SP}/shots/merged-cells.png` });
  await lastRow(page).locator('td').first().click();
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Unmerge cells' }).click();
  await until(async () => (await lastRow(kim).locator('td').count()) === 2);
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
