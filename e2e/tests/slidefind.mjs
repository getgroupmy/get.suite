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
let deckId;
const bar = () => page.getByRole('search', { name: 'Find in presentation' });
const count = () => bar().locator('.find-count').innerText();
await step('setup: a presentation with text, a table and notes', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const content = { theme: 'light', slides: [
    { id: 's1', items: [{ id: 't1', type: 'text', role: 'title', x: 10, y: 10, w: 80, h: 20, size: 40, text: 'Sales review' }], notes: 'Ask about sales targets' },
    { id: 's2', items: [{ id: 'tb', type: 'table', x: 15, y: 25, w: 70, h: 40, size: 18, header: true, cells: [['Region', 'Sales'], ['North', '12']] }] },
    { id: 's3', items: [{ id: 't3', type: 'text', role: 'body', x: 10, y: 40, w: 80, h: 20, size: 24, text: 'Wholesale plan' }] },
  ] };
  deckId = (await api(page, 'POST', '/files/new', { kind: 'slides', name: 'Review deck', content })).body.id;
  await page.goto(`${B}/slides/${deckId}`);
  await page.locator('.slide-stage .slide-text', { hasText: 'Sales review' }).waitFor();
});
await step('Ctrl+F finds in boxes, tables and notes, and goes to each', async () => {
  await page.keyboard.press('Control+f');
  await bar().getByLabel('Find', { exact: true }).fill('sales');
  await until(async () => (await count()) === '1 of 3');
  await bar().getByLabel('Find', { exact: true }).press('Enter');
  await until(async () => (await count()) === '2 of 3');
  await bar().getByLabel('Current match').getByText('Slide 1 · Speaker notes:').waitFor();
  await bar().getByLabel('Find', { exact: true }).press('Enter');
  await bar().getByLabel('Current match').getByText('Slide 2 · Table, row 1:').waitFor();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).and(page.locator('[aria-current=true]')).waitFor();
  await page.locator('.slide-stage .slide-item.table.sel').waitFor();
  await bar().getByLabel('Whole words').uncheck();
  await bar().getByLabel('Find', { exact: true }).fill('sale');
  await until(async () => (await count()) === '1 of 4');
  await bar().getByLabel('Whole words').check();
  await until(async () => (await count()) === 'No results');
});
await step('Replace with a pattern, and replace all', async () => {
  await bar().getByLabel('Whole words').uncheck();
  await bar().getByRole('button', { name: 'Replace…' }).click();
  await bar().getByLabel('Regular expression').check();
  await bar().getByLabel('Find', { exact: true }).fill('(\\d+)');
  await until(async () => (await count()) === '1 of 1');
  await bar().getByLabel('Replace with').fill('$1k');
  await bar().getByRole('button', { name: 'Replace all' }).click();
  await page.locator('.toast', { hasText: 'Replaced 1' }).last().waitFor();
  await until(async () => (await bar().getByLabel('Current match').innerText()).includes('12k'));
  await bar().getByLabel('Regular expression').uncheck();
  await bar().getByLabel('Match case').check();
  await bar().getByLabel('Find', { exact: true }).fill('Sales');
  await until(async () => (await count()) === '1 of 2');
  await bar().getByLabel('Replace with').fill('Revenue');
  await bar().getByRole('button', { name: 'Replace', exact: true }).click();
  await until(async () => (await count()) === '1 of 1');
  await bar().getByRole('button', { name: 'Replace all' }).click();
  await until(async () => (await count()) === 'No results');
  await bar().getByLabel('Match case').uncheck();
  await until(async () => (await count()) === '1 of 1'); // the notes' "sales"
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.locator('.slide-stage .slide-text', { hasText: 'Revenue review' }).waitFor();
  const saved = await until(async () => { const c = (await api(page, 'GET', `/files/${deckId}/content`)).body.content; return JSON.stringify(c).includes('12k') && JSON.stringify(c).includes('Revenue review') && c; });
  const cells = saved.slides[1].items[0].cells;
  if (JSON.stringify(cells) !== JSON.stringify([['Region', 'Revenue'], ['North', '12k']])) throw new Error(JSON.stringify(cells));
  if (saved.slides[0].notes !== 'Ask about sales targets') throw new Error(saved.slides[0].notes);
});
await step('Ctrl+Z undoes a replace', async () => {
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${deckId}/content`)).body.content).includes('"Sales"'));
  await page.keyboard.press('Control+y');
  await until(async () => !JSON.stringify((await api(page, 'GET', `/files/${deckId}/content`)).body.content).includes('"Sales"'));
  await page.keyboard.press('Control+f');
});
await step('Escape closes; the menu opens it; a viewer finds but cannot replace', async () => {
  await bar().getByLabel('Find', { exact: true }).press('Escape');
  await bar().waitFor({ state: 'detached' });
  if (!(await page.locator('.slide-stage .slide-text', { hasText: 'Revenue review' }).count())) throw new Error('redo');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Find and replace' }).click();
  await bar().getByLabel('Replace with').waitFor();
  const vid = (await api(page, 'POST', '/users', { local: 'val', domain: 'acme.com', name: 'Val Viewer', password: 'password123' })).body.id;
  await api(page, 'PUT', `/files/${deckId}/shares`, { shares: [{ user_id: vid, role: 'viewer' }] });
  const v = await mk('val'); await signIn(v, 'val@acme.com');
  await v.goto(`${B}/slides/${deckId}`);
  await v.locator('.slide-stage .slide-text', { hasText: 'Revenue review' }).waitFor();
  await v.keyboard.press('Control+f');
  const vb = v.getByRole('search', { name: 'Find in presentation' });
  await vb.getByLabel('Find', { exact: true }).fill('wholesale');
  await vb.getByLabel('Current match').getByText('Slide 3 · Text:').waitFor();
  await vb.getByRole('button', { name: 'Next match' }).click();
  await v.getByRole('button', { name: 'Slide 3', exact: true }).and(v.locator('[aria-current=true]')).waitFor();
  if (await vb.getByRole('button', { name: /Replace/ }).count()) throw new Error('viewer can replace');
});
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
